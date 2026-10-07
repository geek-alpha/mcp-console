#!/usr/bin/env node
'use strict'
/**
 * 大白（Battle Phoenix）服务器：把大白 CLI 接进控制台，端侧就能直接跟大白交互。
 * ask 起一轮后台任务就立刻返回（端侧等不起几分钟的回复），结果用 result 取；
 * start / stop / status / logs 复用 agent 骨架，长任务可以后台跑、随时看日志。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { serve, resolveBinDetail, resolveDir, startInstance, settleStart, stopInstance, readState, isAlive } = require('./lib/agent.cjs')

/** 工作目录与解释器都自动探测：换机器 / 换安装位置只需在控制台设置页改，不必动脚本 */
const DABAI = resolveDir({
  envKey: 'MCP_AGENT_DABAI_HOME',
  markers: ['dabai_cli.py', 'tools/dabai_cli.py'],
  commonPaths: ['D:/AI/dabai', '%USERPROFILE%/dabai', '~/dabai', '~/projects/dabai', '~/.dabai'],
  fallback: 'D:/AI/dabai'
})
const PYTHON = {
  bin: 'python',
  binNames: ['python3', 'python', 'py'],
  // 控制台「设置 → 工具路径」写的是 MCP_AGENT_PYTHON；老配置里的 DABAI_PYTHON 只在它缺席时才看
  binEnv: ['MCP_AGENT_PYTHON', 'MCP_AGENT_DABAI_PYTHON'],
  commonPaths: ['/usr/bin/python3', '/usr/local/bin/python3', '~/.pyenv/shims/python3']
}

const HOME = DABAI.dir
const CLI = path.join(HOME, 'dabai_cli.py')
const DEFAULT_USER = process.env.MCP_AGENT_DABAI_USER || 'mcp'

const pythonInfo = () => resolveBinDetail(PYTHON)
const pythonBin = () => pythonInfo().bin

const childEnv = () => ({
  ...process.env,
  // Windows 上管道默认走 GBK，中文/emoji 会炸；强制 UTF-8 两端才对齐
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1'
})

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.unref()
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 已经退出 */
    }
  }
}

/** --json 事件流 → { reply, toolCalls, usage }：FinalText 是全文，比逐段拼接更完整 */
function parseDabaiLog(text) {
  const chunks = []
  const toolCalls = []
  let final = ''
  let usage = null
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s[0] !== '{') continue
    let ev
    try {
      ev = JSON.parse(s)
    } catch {
      continue
    }
    if ((ev?.type === 'TextDelta' || ev?.type === 'StreamDelta') && ev.text) chunks.push(ev.text)
    else if (ev?.type === 'FinalText' && ev.text) final = ev.text
    else if (ev?.type === 'ToolCallStart') toolCalls.push({ tool: ev.tool_name, args: ev.arguments })
    else if (ev?.type === 'ToolCallResult') {
      const last = toolCalls[toolCalls.length - 1]
      if (last) {
        last.success = ev.success !== false
        last.result = String(ev.result ?? '').slice(0, 400)
      }
    } else if (ev?.type === 'UsageEvent') {
      usage = { promptTokens: ev.prompt_tokens, completionTokens: ev.completion_tokens, rounds: ev.rounds }
    }
  }
  return { reply: (final || chunks.join('')).trim(), toolCalls, usage }
}

/** 一轮任务能刷出上万行事件，只读末尾一段就够（FinalText 落在最后） */
function readLogText(file, maxBytes = 512 * 1024) {
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - maxBytes)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch {
    return ''
  }
}

/** 后台跑一轮：与 start 共用进程 / 日志 / state，所以 status、stop、logs 都管得到 */
const jobSpec = {
  name: 'dabai',
  label: '大白 CLI',
  ...PYTHON,
  cwd: HOME,
  env: childEnv(),
  buildArgs({ prompt, user }) {
    return [CLI, '--json', '--user', user || DEFAULT_USER, prompt]
  }
}

function jobView(rec) {
  const alive = isAlive(rec.pid)
  const parsed = parseDabaiLog(readLogText(rec.logPath))
  return {
    jobId: rec.id,
    status: alive ? 'running' : parsed.reply ? 'done' : 'ended',
    alive,
    pid: rec.pid,
    elapsedMs: Date.now() - Date.parse(rec.startedAt),
    reply: parsed.reply,
    toolCalls: parsed.toolCalls,
    usage: parsed.usage,
    logPath: rec.logPath
  }
}

/** 要结果时才等：轮询到跑完或超时，默认路径不阻塞 */
async function waitJob(rec, waitMs) {
  const deadline = Date.now() + waitMs
  for (;;) {
    const view = jobView(rec)
    if (view.status !== 'running') return { ok: true, ...view }
    if (Date.now() >= deadline)
      return { ok: true, ...view, timedOut: true, hint: `还在跑，稍后再用 dabai_result 查 ${rec.id}` }
    await new Promise((r) => setTimeout(r, 400))
  }
}

/** 起一轮，只等「真的起来了」：起不来立刻说清楚，起得来立刻回话 */
async function startJob(a) {
  const prompt = String(a.prompt ?? '').trim()
  if (!prompt) throw new Error('dabai 需要 prompt')
  const rec = startInstance(jobSpec, { prompt, user: String(a.user || DEFAULT_USER), label: a.label || 'ask' })
  const settled = await settleStart(rec, 200)
  if (!settled.ok) {
    try {
      stopInstance(jobSpec, rec.id)
    } catch {
      /* 进程本来就没起来 */
    }
    return {
      ok: false,
      status: 'failed',
      error: `连不上大白：${settled.error}`,
      python: rec.bin,
      hint: '在控制台「设置 → 工具路径」把 Python / 大白工作目录指对，或先调 dabai_health 看环境'
    }
  }
  const waitMs = Number(a.waitMs) > 0 ? Number(a.waitMs) : 0
  if (!waitMs) {
    return {
      ok: true,
      status: 'started',
      say: '大白开始干了，不用等它答完',
      jobId: rec.id,
      pid: rec.pid,
      hint: '用 dabai_result 取回复（可带 waitMs 等一会儿）'
    }
  }
  return await waitJob(rec, waitMs)
}

serve({
  name: 'dabai',
  label: '大白 CLI',
  bin: PYTHON.bin,
  binNames: PYTHON.binNames,
  binEnv: PYTHON.binEnv,
  commonPaths: PYTHON.commonPaths,
  cwd: HOME,
  promptHint: '交给大白的一轮任务，例如：把 release 目录里过期的构建产物清理掉',
  buildArgs({ prompt, args }) {
    if (args && args.length) return args
    if (prompt) return [CLI, '--user', DEFAULT_USER, prompt]
    throw new Error('dabai 需要 prompt（后台跑一轮任务），或显式传 args 指定完整参数')
  },
  extraTools: [
    {
      name: 'ask',
      description:
        '让大白跑一轮任务：立刻返回「已开始」，不等它答完（大白的回答通常要几分钟，端侧等不起）。之后用 dabai_result 取回复；确实要当场等就填 waitMs。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '要对大白说的话或交给它的任务' },
          user: { type: 'string', description: `会话 user_id，默认 ${DEFAULT_USER}；换一个就是一条独立记忆线` },
          label: { type: 'string', description: '给这轮起个名字，便于 status 里分辨' },
          waitMs: { type: 'number', description: '要当场等结果就填毫秒数（如 30000）；默认 0 = 立刻返回' }
        },
        required: ['prompt']
      },
      async run(a) {
        return await startJob(a)
      }
    },
    {
      name: 'result',
      description:
        '取大白某轮任务的进展或结果：默认立刻返回（running / done + 已产出的回复），给 waitMs 才等到跑完或超时。',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'dabai_ask 返回的 jobId，省略则取最近一轮' },
          waitMs: { type: 'number', description: '最多等多少毫秒，默认 0 = 立刻返回' }
        }
      },
      async run(a) {
        const instances = readState('dabai')
        const rec = a.jobId ? instances.find((i) => i.id === a.jobId) : instances[instances.length - 1]
        if (!rec) return { ok: false, error: '还没有运行记录' }
        const waitMs = Number(a.waitMs) > 0 ? Number(a.waitMs) : 0
        if (waitMs) return await waitJob(rec, waitMs)
        return { ok: true, ...jobView(rec) }
      }
    },
    {
      name: 'health',
      description: '检查大白环境：python 是否可用、dabai_cli.py 是否就位、工作目录对不对',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const probe = await new Promise((resolve) => {
          const child = spawn(pythonBin(), ['-c', 'import sys; print(sys.version.split()[0])'], {
            cwd: HOME,
            env: childEnv(),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
          })
          let out = ''
          let err = ''
          const timer = setTimeout(() => killTree(child.pid), 20000)
          child.stdout.on('data', (b) => (out += b.toString('utf8')))
          child.stderr.on('data', (b) => (err += b.toString('utf8')))
          child.on('error', (e) => {
            clearTimeout(timer)
            resolve({ ok: false, error: e.message })
          })
          child.on('close', (code) => {
            clearTimeout(timer)
            resolve({ ok: code === 0, version: out.trim(), error: err.trim() || undefined })
          })
        })

        const info = pythonInfo()
        return {
          ok: probe.ok && fs.existsSync(CLI),
          python: info.bin,
          pythonSource: info.source,
          pythonWarn: info.warn,
          pythonVersion: probe.version,
          home: HOME,
          homeSource: DABAI.source,
          homeWarn: DABAI.warn,
          homeExists: fs.existsSync(HOME),
          cli: CLI,
          cliExists: fs.existsSync(CLI),
          user: DEFAULT_USER,
          hint:
            probe.ok && fs.existsSync(CLI)
              ? '环境就绪，可以 dabai_ask'
              : '在控制台「设置 → 工具路径」把大白工作目录 / Python 指到正确位置，或设 MCP_AGENT_DABAI_HOME、MCP_AGENT_DABAI_PYTHON'
        }
      }
    }
  ]
})

process.stderr.write(`dabai 就绪：python=${pythonBin()} home=${HOME}（${fs.existsSync(CLI) ? 'CLI 已找到' : 'CLI 未找到'}）\n`)
