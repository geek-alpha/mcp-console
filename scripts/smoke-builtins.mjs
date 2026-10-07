/**
 * 内置助手服务器自检：codex / opencode / dsh 三个服务器
 *  ① 走控制台同一条路径（tester.js + Electron 自带 node）做真实 MCP 握手，断言 tools 齐全
 *  ② 再起一个轻客户端真调工具，验证 start → status → logs → stop 整条链路
 * 运行：node scripts/smoke-builtins.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { testServer } = require('../dist/main/tester.js')
const electronPath = require('electron')

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '..', 'servers')

const settings = { pythonPath: 'python', logLimit: 800, maxBackoffMs: 5000, autoStartAll: false }
const nodeEnv = { ELECTRON_RUN_AS_NODE: '1' }
const TOOL_NAMES = ['start', 'stop', 'status', 'logs']
const seenTools = new Map()

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

function makeServer(name) {
  return {
    id: `srv_${name}`,
    name,
    transport: 'stdio',
    enabled: true,
    command: electronPath,
    args: [path.join(dir, `${name}.cjs`)],
    env: nodeEnv
  }
}

/** 极简 stdio JSON-RPC 客户端，用来真调 MCP 工具 */
function connect(server) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env } })
  const pending = new Map()
  let buffer = ''
  let nextId = 1
  const stderr = []

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = pending.get(msg.id)
      if (waiter) {
        pending.delete(msg.id)
        waiter(msg)
      }
    }
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

  const request = (method, params) => {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`超时：${method}`))
      }, 30000)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      })
    })
  }

  return {
    request,
    stderr,
    async call(name, args) {
      const result = await request('tools/call', { name, arguments: args ?? {} })
      const text = result?.content?.[0]?.text ?? ''
      if (result?.isError) throw new Error(text)
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    },
    close() {
      child.stdin.end()
      child.kill()
    }
  }
}

console.log('=== ① 握手（与控制台同一条代码路径）===')
for (const name of ['codex', 'opencode', 'dsh']) {
  const result = await testServer(makeServer(name), settings, 25000)
  const tools = result.tools ?? []
  check(`${name} 握手通过`, result.ok, result.error ?? '')
  const expect = TOOL_NAMES.map((t) => `${name}_${t}`)
  check(`${name} 暴露 ${TOOL_NAMES.length} 个带前缀工具`, expect.every((t) => tools.includes(t)), `tools=${JSON.stringify(tools)}`)
  for (const t of tools) {
    if (seenTools.has(t)) check(`工具名 ${t} 与其他助手不重复`, false, `已被 ${seenTools.get(t)} 占用`)
    else seenTools.set(t, name)
  }
}

console.log('\n=== ② 真实启停链路（codex --help 当靶子，不调模型）===')
const client = connect(makeServer('codex'))
try {
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} })

  const started = await client.call('codex_start', { args: ['exec', '--help'], label: 'smoke-help' })
  check('start 返回 pid', Number.isInteger(started?.instance?.pid), `pid=${started?.instance?.pid}`)
  check('start 写了日志文件', Boolean(started?.instance?.logPath), started?.instance?.logPath ?? '')

  // codex 冷启动到吐字要几百毫秒，等它写完再读
  await new Promise((r) => setTimeout(r, 3000))
  const status = await client.call('codex_status', { id: started.instance.id, tail: 20 })
  const view = status.instances?.[0]
  check('status 认得这个实例', view?.id === started.instance.id, `id=${view?.id}`)
  check('status 带回日志尾部', Array.isArray(view?.tail) && view.tail.length > 0, `lines=${view?.tail?.length ?? 0}`)

  const logs = await client.call('codex_logs', { id: started.instance.id, tail: 20 })
  check('logs 读到 codex 输出', (logs.lines ?? []).length >= 5, `lines=${logs.lines?.length ?? 0} head=${(logs.lines ?? [])[0] ?? ''}`)

  const stopped = await client.call('codex_stop', { id: started.instance.id })
  check('stop 成功', stopped.ok === true, JSON.stringify(stopped.results ?? stopped))
  await new Promise((r) => setTimeout(r, 800))
  const after = await client.call('codex_status', { id: started.instance.id })
  check('stop 后进程已不在', after.instances?.[0]?.alive === false, `alive=${after.instances?.[0]?.alive}`)
} catch (err) {
  check(`启停链路（${err.message}）`, false)
  if (client.stderr.length) console.log(client.stderr.join(''))
} finally {
  client.close()
}

console.log('\n=== ③ 内置服务器不写死安装位置 ===')
const { builtinServers, repairBuiltinServers } = require('../dist/main/builtins.js')
const DRIVE = /[A-Za-z]:\\/

const fresh = builtinServers(settings)
check(
  '新建内置服务器：命令与脚本都是引用',
  fresh.length === 4 && fresh.every((s) => s.command === '{node}' && /^\{servers}\/[a-z]+\.cjs$/.test(String(s.args?.[0]))),
  fresh.map((s) => `${s.command} ${(s.args ?? []).join(' ')}`).join(' | ')
)
check(
  '新建内置服务器：说明文本里没有绝对路径',
  fresh.every((s) => !DRIVE.test(String(s.note ?? ''))),
  `notes=${JSON.stringify(fresh.map((s) => s.note))}`
)

const legacy = [
  {
    id: 'srv_legacy',
    name: 'Codex 启停',
    transport: 'stdio',
    enabled: true,
    command: 'D:\\AI\\wife_bot\\mcp-console\\release\\win-unpacked\\MCP Console.exe',
    args: ['D:\\AI\\wife_bot\\mcp-console\\release\\win-unpacked\\resources\\servers\\codex.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    note: 'codex_start/stop/status/logs：给 prompt 走 codex exec｜脚本：D:\\AI\\wife_bot\\mcp-console\\release\\win-unpacked\\resources\\servers\\codex.cjs｜运行时：C:\\nvm4w\\nodejs\\node.exe｜工具路径：Codex CLI → C:\\nvm4w\\nodejs\\codex.cmd（PATH）'
  }
]
const repaired = repairBuiltinServers(legacy, settings)
const fixed = repaired.servers[0]
check(
  '旧配置：命令压回引用、快照清掉',
  fixed.command === '{node}' && fixed.args?.[0] === '{servers}/codex.cjs' && !String(fixed.note ?? '').includes('｜脚本：'),
  `command=${fixed.command} note=${fixed.note}`
)
check('旧配置：说明文本里不再有盘符路径', !DRIVE.test(String(fixed.note ?? '')), String(fixed.note ?? ''))
check('旧配置：修复数计入（含说明文本清理）', repaired.result.fixed === 1, `fixed=${repaired.result.fixed} details=${JSON.stringify(repaired.result.details)}`)
check(
  '幂等：再跑一次不再改动',
  repairBuiltinServers(repaired.servers, settings).result.fixed === 0,
  `fixed=${repairBuiltinServers(repaired.servers, settings).result.fixed}`
)
const custom = [{ id: 'srv_c', name: '我的服务器', transport: 'stdio', enabled: true, command: 'python', args: ['x.py'] }]
const kept = repairBuiltinServers(custom, settings)
check(
  '自定义服务器不被碰',
  kept.result.fixed === 0 && kept.servers[0].command === 'python' && kept.servers[0].args[0] === 'x.py',
  `fixed=${kept.result.fixed}`
)

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length ? 1 : 0)
