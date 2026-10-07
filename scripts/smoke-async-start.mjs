/**
 * 端侧响应性冒烟：小智设备调工具必须「立刻」拿到回话，不能等任务跑完。
 * 覆盖三件事——① 每个助手的 start 立刻返回「已开始」；② 连不上时立刻返回失败（不是假成功）；
 * ③ dabai_ask 非阻塞，结果用 dabai_result 取。
 * 运行：node scripts/smoke-async-start.mjs
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUDGET_MS = 1500
let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) {
    pass++
    console.log(`PASS  ${name}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${JSON.stringify(extra)}`)
  }
}

function client(script, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buf = ''
  let stderr = ''
  const pending = new Map()
  child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        p(msg)
      }
    }
  })
  let seq = 0
  const rpc = (method, params, timeoutMs = 60000) => {
    const id = ++seq
    const t0 = Date.now()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ timedOut: true, ms: Date.now() - t0 })
      }, timeoutMs)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve({ msg, ms: Date.now() - t0 })
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args })
    const text = r.msg?.result?.content?.[0]?.text
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: String(text).slice(0, 200) }
    }
    return { ms: r.ms, payload, timedOut: r.timedOut }
  }
  return { child, rpc, call, stderr: () => stderr.trim() }
}

const AGENTS = [
  ['servers/codex.cjs', 'codex'],
  ['servers/opencode.cjs', 'opencode'],
  ['servers/dsh.cjs', 'dsh'],
  ['servers/dabai.cjs', 'dabai']
]

console.log('--- ① 正常路径：start 立刻回「已开始」 ---')
for (const [script, agent] of AGENTS) {
  const c = client(script)
  await sleep(500)
  await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  const r = await c.call(`${agent}_start`, { prompt: 'print hi', label: 'smoke' })
  const ok = r.payload?.ok === true && r.payload?.status === 'started' && r.ms < BUDGET_MS
  check(`${agent}_start 立刻返回已开始`, ok, `${r.ms}ms status=${r.payload?.status}`)
  await c.call(`${agent}_stop`, { all: true })
  c.child.kill()
  await sleep(200)
}

console.log('\n--- ② 连不上：必须立刻说失败，不能假成功 ---')
for (const [mode, label] of [
  ['missing', '可执行文件不存在'],
  ['exit', '起来就非零退出']
]) {
  const c = client('scripts/fixtures/agent-fail-probe.cjs', { PROBE_MODE: mode })
  await sleep(500)
  await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  const r = await c.call('probe_start', { prompt: 'x' })
  const ok =
    r.payload?.ok === false && r.payload?.status === 'failed' && /连不上/.test(String(r.payload?.error)) && r.ms < BUDGET_MS
  check(`${label} 立刻报连不上`, ok, `${r.ms}ms ${String(r.payload?.error ?? JSON.stringify(r.payload)).slice(0, 90)}`)
  await c.call('probe_stop', { all: true })
  c.child.kill()
  await sleep(200)
}

console.log('\n--- ③ 大白：ask 非阻塞，result 取结果 ---')
{
  const c = client('servers/dabai.cjs')
  await sleep(500)
  await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  const asked = await c.call('dabai_ask', { prompt: '用一句话说你好', label: 'smoke' })
  check(
    'dabai_ask 立刻返回已开始',
    asked.payload?.ok === true && asked.payload?.status === 'started' && Boolean(asked.payload?.jobId) && asked.ms < BUDGET_MS,
    `${asked.ms}ms jobId=${asked.payload?.jobId}`
  )
  const got = await c.call('dabai_result', { jobId: asked.payload?.jobId })
  check(
    'dabai_result 立刻返回进展',
    got.ms < BUDGET_MS && ['running', 'done', 'ended'].includes(got.payload?.status),
    `${got.ms}ms status=${got.payload?.status} replyLen=${String(got.payload?.reply ?? '').length}`
  )
  const waited = await c.call('dabai_result', { jobId: asked.payload?.jobId, waitMs: 25000 })
  check(
    'waitMs 显式等待能拿到回复',
    waited.payload?.ok === true && String(waited.payload?.reply ?? '').length > 0,
    `${waited.ms}ms status=${waited.payload?.status} reply=${String(waited.payload?.reply ?? '').slice(0, 40)}`
  )
  await c.call('dabai_stop', { all: true })
  c.child.kill()
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
