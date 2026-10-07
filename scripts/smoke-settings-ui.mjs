/**
 * 设置页 UI 回归：真实 Electron + CDP 驱动，专盯「点了按钮整页崩成白屏」这类只有真点才会暴露的问题。
 *  ① 设置页有「写入内置服务器」按钮
 *  ② 点它之后页面还活着（按钮数不归零）、没有未捕获异常
 *  ③ 手填「工具路径」里 Python 那一行能落盘
 * 用真实 config.json 的副本（接入点换成本地 mock）+ 独立 userData，不碰正在使用的控制台。
 * 运行：node scripts/smoke-settings-ui.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { WebSocketServer } from 'ws'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = process.cwd()
const CDP_PORT = Number(process.env.MCP_CONSOLE_CDP_PORT || 9335)
const WS_PORT = Number(process.env.MCP_CONSOLE_MOCK_WS_PORT || 8798)
const userData = path.join(root, '.smoke-settings-userdata')
const realConfig = path.join(process.env.APPDATA ?? '', 'MCP Console', 'config.json')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const cfg = existsSync(realConfig)
  ? JSON.parse(readFileSync(realConfig, 'utf8'))
  : {
      version: 1,
      endpoints: [],
      devices: [],
      servers: [],
      settings: { pythonPath: 'python', logLimit: 800, maxBackoffMs: 5000, autoStartAll: false }
    }
cfg.endpoints = [{ id: 'ep_smoke', name: '冒烟接入点', url: `ws://127.0.0.1:${WS_PORT}`, enabled: true }]
for (const d of cfg.devices) d.endpointId = 'ep_smoke'
cfg.settings.autoStartAll = false
writeFileSync(path.join(userData, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')

const wss = new WebSocketServer({ port: WS_PORT })
wss.on('connection', (ws) => ws.on('message', () => {}))

const child = spawn(electronPath, ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP_PORT}`], {
  cwd: root,
  stdio: 'ignore'
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  } catch {
    /* 还没起来 */
  }
}
if (!page) {
  console.log('FAIL  连不上渲染进程（CDP）')
  child.kill()
  wss.close()
  process.exit(1)
}

const { WebSocket } = await import('ws')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.on('open', r))
let seq = 0
const pending = new Map()
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const ex = res.result?.exceptionDetails
  if (ex) return 'THREW: ' + String(ex.exception?.description ?? JSON.stringify(ex)).slice(0, 300)
  return res.result?.result?.value
}
const clickText = (text) => `(() => {
  const el = [...document.querySelectorAll('button,a')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})
  if (!el) return 'missing'
  el.click()
  return 'clicked'
})()`

/** CDP 一连上就操作会撞上 React 首屏还没渲染完：先等到目标出现再点 */
async function waitFor(expression, timeoutMs = 20000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(expression)
    if (value) return value
    if (Date.now() >= deadline) return null
    await sleep(stepMs)
  }
}

await send('Runtime.enable')
await evaluate(
  `window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message)));` +
    `window.__rejs = []; window.addEventListener('unhandledrejection', (e) => window.__rejs.push(String(e.reason)))`
)

console.log('--- 打开设置页 ---')
await waitFor(`[...document.querySelectorAll('button,a')].some((b) => b.textContent.trim() === '⚙设置')`)
const navRet = await evaluate(clickText('⚙设置'))
check('侧边栏能进设置页', navRet === 'clicked', `ret=${navRet}`)
await sleep(2500)

const buttons = JSON.parse((await evaluate(`JSON.stringify([...document.querySelectorAll('button')].map((b) => b.textContent.trim()))`)) || '[]')
check('设置页有「写入内置服务器」按钮', buttons.includes('写入内置服务器'), `buttons=${JSON.stringify(buttons.slice(-9))}`)
check('设置页有「重新探测」按钮', buttons.includes('重新探测'))
check('设置页没有独立的保存按钮（设计是修改即保存）', !buttons.some((b) => b === '保存'), `buttons=${JSON.stringify(buttons)}`)

console.log('\n--- 工具路径表能不能填出来（探测接口的时序与异常）---')
const probe = await evaluate(`(async () => {
  const t0 = performance.now()
  let rows = []
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    rows = [...document.querySelectorAll('.table tbody tr')].map((e) => (e.textContent || '').trim())
    if (rows.some((t) => t.includes('Codex CLI')) && rows.some((t) => t.includes('Python'))) break
  }
  let call = null
  try {
    const r = await window.mcpConsole.detectToolchain(true)
    call = { n: r?.entries?.length ?? null, at: r?.scannedAt ?? null }
  } catch (e) {
    call = { error: String(e).slice(0, 200) }
  }
  return {
    ms: Math.round(performance.now() - t0),
    hasCodex: rows.some((t) => t.includes('Codex CLI')),
    hasPython: rows.some((t) => t.includes('Python')),
    rows: rows.length,
    call,
    rejs: (window.__rejs || []).slice(0, 3)
  }
})()`)
check('工具路径表填出了探测结果（Codex CLI / Python 行）', probe?.hasCodex && probe?.hasPython, `rows=${probe?.rows} ms=${probe?.ms}`)
check('探测接口能返回 entries', Number(probe?.call?.n) >= 5, `call=${JSON.stringify(probe?.call)}`)
check('探测过程没有未捕获 rejection', Array.isArray(probe?.rejs) && probe.rejs.length === 0, `rejs=${JSON.stringify(probe?.rejs)}`)

console.log('\n--- 点「写入内置服务器」---')
const applied = await evaluate(`(async () => {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '写入内置服务器')
  if (!el) return { error: '没找到按钮' }
  const t0 = performance.now()
  el.click()
  await new Promise((r) => setTimeout(r, 1500))
  return {
    ms: Math.round(performance.now() - t0),
    buttons: document.querySelectorAll('button').length,
    bodyLen: document.body.innerText.length,
    errs: (window.__errs || []).slice(0, 3),
    keptPage: document.body.innerText.includes('工具路径')
  }
})()`)
check('点击后 1.5 秒内页面没崩（按钮还在）', applied?.buttons > 10, `buttons=${applied?.buttons} bodyLen=${applied?.bodyLen}`)
check('点击后页面仍是设置页', applied?.keptPage === true)
check('点击过程没有未捕获异常', Array.isArray(applied?.errs) && applied.errs.length === 0, `errs=${JSON.stringify(applied?.errs)}`)

const resultShape = await evaluate(
  `(async () => { const r = await window.mcpConsole.applyToolchain(); return JSON.stringify({ ok: r.ok, updated: r.updated, isArray: Array.isArray(r.entries), n: r.entries?.length }) })()`
)
check(
  '接口返回的 entries 是数组（类型声明一致）',
  /"isArray":true/.test(String(resultShape)),
  String(resultShape)
)

console.log('\n--- 手填工具路径能不能落盘 ---')
const typed = await evaluate(`(async () => {
  const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes('Python 解释器'))
  if (!row) return { error: '没找到 Python 行' }
  const input = row.querySelector('input')
  if (!input) return { error: 'Python 行没有输入框' }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const want = 'C:\\\\Users\\\\wangxingfeng\\\\AppData\\\\Local\\\\Programs\\\\Python\\\\Python313\\\\python.exe'
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  for (let i = 1; i <= want.length; i++) {
    setter.call(input, want.slice(0, i))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  }
  await new Promise((r) => setTimeout(r, 700))
  const cfg = await window.mcpConsole.getConfig()
  return { shown: input.value, stored: cfg.settings.toolPaths?.python ?? null }
})()`)
check(
  '手填的路径留在输入框里（没被回弹覆盖）',
  String(typed?.shown).includes('Python313'),
  `shown=${JSON.stringify(typed?.shown)}`
)
check(
  '手填的路径写进 config',
  String(typed?.stored).includes('Python313'),
  `stored=${JSON.stringify(typed?.stored)}`
)

ws.close()
child.kill()
await sleep(800)
const saved = JSON.parse(readFileSync(path.join(userData, 'config.json'), 'utf8'))
check('重启前配置已落盘', String(saved.settings.toolPaths?.python ?? '').includes('Python313'), `file=${saved.settings.toolPaths?.python}`)
rmSync(userData, { recursive: true, force: true })
wss.close()

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length ? 1 : 0)
