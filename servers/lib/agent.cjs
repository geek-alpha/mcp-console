'use strict'
/**
 * codex / opencode / dsh 三个助手服务器共用的 MCP stdio 骨架 + 进程管理。
 * 零依赖：由控制台用 Electron 自带的 node 拉起（ELECTRON_RUN_AS_NODE=1），目标机器不需要装 node。
 *
 * 每个助手暴露同一组工具：start（后台起进程）、stop（终止）、status（探活）、logs（看输出尾部）。
 * 助手还能用 spec.extraTools 追加自己的工具（如大白的 ask），工具名同样带前缀。
 * 进程 detached 启动并落盘 pid，所以控制台重启后仍然找得回、杀得掉。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

const PROTOCOL_VERSION = '2024-11-05'
const TAIL_BYTES = 64 * 1024

const winQuote = (v) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v)

/** .cmd/.bat（pnpm、codex 这类）在 Windows 上必须经 cmd.exe 才能起 */
function buildSpawn(bin, argv) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const line = [bin, ...argv].map(winQuote).join(' ')
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', line] }
  }
  return { file: bin, args: argv }
}

function stateDir(agent) {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || os.tmpdir()
      : path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'mcp-console-agents', agent)
}

function paths(agent) {
  const dir = stateDir(agent)
  return { dir, state: path.join(dir, 'state.json'), logs: path.join(dir, 'logs') }
}

function readState(agent) {
  const { state } = paths(agent)
  try {
    const parsed = JSON.parse(fs.readFileSync(state, 'utf8'))
    return Array.isArray(parsed?.instances) ? parsed.instances : []
  } catch {
    return []
  }
}

function writeState(agent, instances) {
  const { dir, state } = paths(agent)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${state}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ instances }, null, 2), 'utf8')
  fs.renameSync(tmp, state)
}

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function tailLines(file, count) {
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - TAIL_BYTES)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const lines = buf.toString('utf8').split(/\r?\n/)
    return lines.slice(-count).filter((l, i) => l.length > 0 || i < lines.length - 1)
  } catch {
    return []
  }
}

function probePort(port, timeout = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function expandHome(value) {
  let out = String(value)
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1))
  out = out.replace(/%([^%]+)%/g, (m, key) => process.env[key] || m)
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, key) => process.env[key] || m)
  return out
}

function isExecFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    if (process.platform === 'win32') return true
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Windows 上「codex」实际是 codex.cmd / codex.exe，按 PATHEXT 试扩展名 */
function nameVariants(name) {
  if (path.extname(name)) return [name]
  if (process.platform !== 'win32') return [name]
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [...exts.map((e) => name + e.toLowerCase()), ...exts.map((e) => name + e), name]
}

function findInPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const name of names) {
    for (const variant of nameVariants(name)) {
      for (const dir of dirs) {
        const full = path.join(dir, variant)
        if (isExecFile(full)) return full
      }
    }
  }
  return null
}

/**
 * 多级解析可执行文件：显式 env → PATH → 常见安装位置 → 兜底名。
 * binEnv 可以是数组（规范名在前、历史别名在后）；env 值不可用时继续往下找——
 * 老配置里常残留一个过期或占位的值，就地返回会把 PATH 兜底也一起掐死。
 */
function resolveBinDetail(spec) {
  const names = (spec.binNames && spec.binNames.length ? spec.binNames : spec.bin ? [spec.bin] : []).map((n) =>
    String(n).replace(/\.(cmd|exe|bat|ps1)$/i, '')
  )
  const envKeys = (Array.isArray(spec.binEnv) ? spec.binEnv : spec.binEnv ? [spec.binEnv] : []).filter(Boolean)
  let envWarn
  for (const key of envKeys) {
    const raw = process.env[key]
    if (!raw || !raw.trim()) continue
    const value = raw.trim()
    // 值可能是个命令名（老配置里就存着 'python'）：直接 path.resolve 会把它变成 cwd 下的假路径
    if (!/[/\\]/.test(value)) {
      const named = findInPath([value])
      if (named) return { bin: named, source: 'env', names, envKey: key }
      if (!envWarn) envWarn = `${key} 里写的「${value}」不是路径，PATH 里也没有这个命令`
      continue
    }
    const full = path.resolve(expandHome(value))
    if (isExecFile(full)) return { bin: full, source: 'env', names, envKey: key }
    if (!envWarn) envWarn = `${key} 指向的路径不可用：${full}`
  }
  const hit = findInPath(names)
  if (hit) return { bin: hit, source: 'path', names, warn: envWarn }
  for (const candidate of spec.commonPaths || []) {
    const full = path.resolve(expandHome(candidate))
    if (isExecFile(full)) return { bin: full, source: 'common', names, warn: envWarn }
  }
  const fallback = spec.bin || names[0]
  return {
    bin: fallback,
    source: 'fallback',
    names,
    warn:
      envWarn ??
      `PATH 和常见位置都没找到 ${names.join(' / ')}，退回到「${fallback}」；可在控制台「设置 → 工具路径」指定完整路径，或设环境变量 ${envKeys[0] ?? 'MCP_AGENT_*'}`
  }
}

function resolveBin(spec) {
  return resolveBinDetail(spec).bin
}

/** 目录型工具（dsh 仓库、大白工作目录）：env → 带标志文件的常见位置 → 兜底 */
function resolveDir({ envKey, commonPaths, markers, fallback }) {
  const explicit = envKey ? process.env[envKey] : null
  if (explicit && explicit.trim()) {
    const full = path.resolve(expandHome(explicit.trim()))
    if (fs.existsSync(full)) return { dir: full, source: 'env' }
    return { dir: full, source: 'env', warn: `${envKey} 指向的目录不存在：${full}` }
  }
  for (const candidate of commonPaths || []) {
    const full = path.resolve(expandHome(candidate))
    if (!fs.existsSync(full)) continue
    if (markers && markers.length && !markers.some((m) => fs.existsSync(path.join(full, m)))) continue
    return { dir: full, source: 'common' }
  }
  return {
    dir: path.resolve(expandHome(fallback || '.')),
    source: 'fallback',
    warn: `没找到 ${envKey || '目录'} 对应的位置，先用「${fallback}」；可在控制台「设置 → 工具路径」指定`
  }
}

function startInstance(spec, opts) {
  // buildArgs 允许返回 { argv, port }：端口随运行模式变（serve 听端口、exec 不听）
  const built = spec.buildArgs(opts)
  const argv = Array.isArray(built) ? built : built.argv
  const port = Array.isArray(built) ? spec.port ?? null : built.port ?? spec.port ?? null
  const resolved = resolveBinDetail(spec)
  const bin = resolved.bin
  const cwd = opts.cwd || spec.cwd || process.cwd()
  const id = `${spec.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const logPath = path.join(paths(spec.name).logs, `${id}.log`)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  if (resolved.warn) {
    try {
      fs.appendFileSync(logPath, `[warn] ${resolved.warn}\n`)
    } catch {
      /* 日志写不进去不影响启动 */
    }
  }

  const fd = fs.openSync(logPath, 'a')
  const { file, args } = buildSpawn(bin, argv)
  let child
  let earlyError = null
  try {
    child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...(spec.env ?? {}), ...(opts.env ?? {}) },
      // Windows 上 detached(DETACHED_PROCESS) 会让经 cmd.exe 的输出重定向全部失效（实测 cmd /c node -e 也丢输出），
      // 所以只在 POSIX 上用 detached 拿进程组；Windows 的父进程退出不连带杀子进程，pid 已落盘、taskkill /T 照样收得掉
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', fd, fd]
    })
    // 可执行文件不存在时 spawn 会异步抛 error：不接住会把整个服务器进程带走
    child.on('error', (err) => {
      earlyError = err
      try {
        fs.appendFileSync(logPath, `[error] 启动失败：${err.message}\n`)
      } catch {
        /* 忽略 */
      }
    })
    child.unref()
  } finally {
    fs.closeSync(fd)
  }

  const record = {
    id,
    pid: child.pid,
    label: opts.label || spec.label,
    bin,
    binSource: resolved.source,
    argv,
    cwd,
    startedAt: new Date().toISOString(),
    logPath,
    port
  }
  // child / earlyError 只挂在内存对象上：不可枚举，落盘时自动跳过
  Object.defineProperty(record, '_child', { value: child, enumerable: false })
  Object.defineProperty(record, '_earlyError', { value: () => earlyError, enumerable: false })
  writeState(spec.name, [...readState(spec.name), record])
  return record
}

/**
 * 启动后只等一小会儿，确认「真的起来了」再回话。
 * spawn 的 ENOENT/EACCES 是异步抛的：不等就返回，端侧会收到一个「已开始」而进程根本没跑。
 * 200ms 内没出错即视为已启动（ENOENT 实测 6ms、cmd 找不到命令 85ms 就能抓至），不拖慢端侧响应。
 */
function settleStart(record, waitMs = 200) {
  const child = record?._child
  if (!child) return Promise.resolve({ ok: false, error: '没有拿到进程句柄' })
  const known = record._earlyError?.()
  if (known) return Promise.resolve({ ok: false, error: known.message, code: known.code })

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      resolve(value)
    }
    const onError = (err) => finish({ ok: false, error: err.message, code: err.code })
    // 立刻退出算连不上；退出码 0 说明是短任务已经正常跑完，不算失败
    const onExit = (code) => finish(code === 0 ? { ok: true, exited: true } : { ok: false, error: `进程启动后立刻退出，退出码 ${code}` })
    const timer = setTimeout(() => finish({ ok: true }), waitMs)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function stopInstance(spec, id) {
  const instances = readState(spec.name)
  const target = instances.find((i) => i.id === id)
  if (!target) return { ok: false, error: `实例不存在：${id}` }
  if (!isAlive(target.pid)) return { ok: true, id, pid: target.pid, note: '进程早已退出' }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(target.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.unref()
  } else {
    try {
      process.kill(-target.pid, 'SIGTERM')
    } catch {
      process.kill(target.pid, 'SIGTERM')
    }
  }
  writeState(
    spec.name,
    instances.map((i) => (i.id === id ? { ...i, stoppedAt: new Date().toISOString() } : i))
  )
  return { ok: true, id, pid: target.pid, signal: process.platform === 'win32' ? 'taskkill /T /F' : 'SIGTERM' }
}

async function viewInstance(record) {
  const alive = isAlive(record.pid)
  const view = {
    id: record.id,
    label: record.label,
    pid: record.pid,
    alive,
    argv: [record.bin, ...record.argv].join(' '),
    binSource: record.binSource,
    cwd: record.cwd,
    startedAt: record.startedAt,
    uptimeSeconds: Math.round((Date.now() - Date.parse(record.startedAt)) / 1000),
    logPath: record.logPath
  }
  if (record.port) {
    view.port = record.port
    view.portListening = alive ? await probePort(record.port) : false
  }
  if (record.stoppedAt) view.stoppedAt = record.stoppedAt
  if (!alive) view.tail = tailLines(record.logPath, 5)
  return view
}

/** 工具名带助手前缀（codex_start…）：三个助手的同名工具在接入点侧不会互相覆盖 */
function buildTools(spec) {
  const n = (tool) => `${spec.name}_${tool}`
  return [
    {
      name: n('start'),
      description: `立刻让 ${spec.label} 开始跑：不等任务结束，马上返回「已开始」和实例 id（输出写日志，可随时 status / logs / stop）。只有连不上时才返回失败。`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: spec.promptHint },
          args: { type: 'array', items: { type: 'string' }, description: '追加的命令行参数，覆盖默认参数' },
          cwd: { type: 'string', description: `工作目录，默认 ${spec.cwd}` },
          label: { type: 'string', description: '给这次运行起个名字，便于 status 里分辨' }
        }
      }
    },
    {
      name: n('stop'),
      description: `终止 ${spec.label} 进程（Windows 走 taskkill /T /F，连子进程一起收）`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '实例 id，省略则终止全部在跑的实例' },
          all: { type: 'boolean', description: 'true 时终止全部在跑的实例' }
        }
      }
    },
    {
      name: n('status'),
      description: `查看 ${spec.label} 实例：pid、是否存活、运行时长${spec.port ? `、${spec.port} 端口是否在听` : ''}、日志尾部`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '只看某个实例' },
          tail: { type: 'number', description: '日志尾部行数，默认 5' }
        }
      }
    },
    {
      name: n('logs'),
      description: `读取 ${spec.label} 某次运行的输出尾部`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '实例 id，省略则取最近一次运行' },
          tail: { type: 'number', description: '行数，默认 60' }
        }
      }
    },
    ...(spec.extraTools ?? []).map((t) => ({
      name: n(t.name),
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} }
    }))
  ]
}

async function callTool(spec, name, args) {
  const a = args ?? {}
  // 容忍裸名调用（老配置/手工调用），但对外只暴露带前缀的名字
  const tool = name.startsWith(`${spec.name}_`) ? name.slice(spec.name.length + 1) : name
  const extra = (spec.extraTools ?? []).find((t) => t.name === tool)
  if (extra) return await extra.run(a, spec)

  if (tool === 'start') {
    const rec = startInstance(spec, {
      prompt: a.prompt,
      args: Array.isArray(a.args) ? a.args.map(String) : undefined,
      cwd: a.cwd,
      label: a.label
    })
    // 端侧（小智设备）要的是「一句话确认」，不是等任务跑完；但起不来必须立刻说清楚
    const settled = await settleStart(rec, spec.settleMs ?? 200)
    if (!settled.ok) {
      try {
        stopInstance(spec, rec.id)
      } catch {
        /* 进程本来就没起来 */
      }
      return {
        ok: false,
        status: 'failed',
        error: `连不上 ${spec.label}：${settled.error}`,
        bin: rec.bin,
        binSource: rec.binSource,
        hint: '在控制台「设置 → 工具路径」把可执行文件指到正确位置，或确认它已经安装'
      }
    }
    return {
      ok: true,
      status: 'started',
      say: `已让 ${spec.label} 开始干活，不用等它跑完`,
      instance: {
        id: rec.id,
        pid: rec.pid,
        label: rec.label,
        alive: isAlive(rec.pid),
        startedAt: rec.startedAt,
        argv: [rec.bin, ...rec.argv].join(' '),
        logPath: rec.logPath
      },
      hint: `用 ${spec.name}_status 看进度、${spec.name}_logs 看输出、${spec.name}_stop 终止`
    }
  }

  if (tool === 'stop') {
    const instances = readState(spec.name)
    const targets = a.id ? instances.filter((i) => i.id === a.id) : instances.filter((i) => isAlive(i.pid))
    if (!targets.length) return { ok: true, stopped: [], note: '没有在跑的实例' }
    const results = targets.map((t) => stopInstance(spec, t.id))
    return { ok: results.every((r) => r.ok), results }
  }

  if (tool === 'status') {
    const instances = readState(spec.name)
    const picked = a.id ? instances.filter((i) => i.id === a.id) : instances.slice(-10)
    if (!picked.length) return { ok: true, instances: [], note: `${spec.label} 还没有运行记录` }
    const views = []
    for (const rec of picked) {
      const view = await viewInstance(rec)
      if (a.tail) view.tail = tailLines(rec.logPath, a.tail)
      views.push(view)
    }
    return { ok: true, instances: views }
  }

  if (tool === 'logs') {
    const instances = readState(spec.name)
    const rec = a.id ? instances.find((i) => i.id === a.id) : instances[instances.length - 1]
    if (!rec) return { ok: false, error: '还没有运行记录' }
    return { ok: true, id: rec.id, logPath: rec.logPath, lines: tailLines(rec.logPath, a.tail ?? 60) }
  }

  throw new Error(`未知工具：${name}`)
}

/** 把 spec 变成一个可被控制台拉起的 MCP stdio 服务器 */
function serve(spec) {
  const tools = buildTools(spec)
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)

  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    const text = line.trim()
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    const { id, method, params } = msg ?? {}

    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: spec.name, version: '0.1.0' }
        }
      })
      return
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
      return
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools } })
      return
    }
    if (method === 'tools/call') {
      try {
        const payload = await callTool(spec, params?.name, params?.arguments)
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false }
        })
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true }
        })
      }
      return
    }
    if (id !== undefined && id !== null) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法：${method}` } })
    }
  })

  process.stderr.write(`${spec.name} 已就绪（stdio）\n`)
}

module.exports = {
  serve,
  paths,
  readState,
  isAlive,
  tailLines,
  probePort,
  startInstance,
  settleStart,
  stopInstance,
  viewInstance,
  callTool,
  buildTools,
  expandHome,
  resolveBinDetail,
  resolveDir
}
