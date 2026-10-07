/**
 * 全链路冒烟：写一份临时配置（mock 接入点 + mock MCP 服务器）→ 启动真实 Electron 主进程
 * → 主进程 startAll → 抓取运行时状态与界面状态。
 * 用独立 userData 跑：不抢正在使用的控制台的单实例锁，也不碰真实配置。
 * 运行：node scripts/smoke-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { WebSocketServer } from 'ws'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const exePath = process.env.MCP_CONSOLE_E2E_EXE || electronPath

const root = process.cwd()
const PORT = 8799
const userData = process.env.MCP_CONSOLE_SMOKE_USERDATA || path.join(root, '.smoke-userdata')
const configPath = path.join(userData, 'config.json')
const reportPath = path.join(root, 'smoke-report.json')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

rmSync(userData, { recursive: true, force: true })

const LEGACY_BUILTINS = [
  { name: 'Codex 启停', script: 'codex.cjs' },
  { name: 'OpenCode 启停', script: 'opencode.cjs' },
  { name: 'DSH 启停', script: 'dsh.cjs' },
  { name: '大白 交互', script: 'dabai.cjs' }
]

const smokeConfig = {
  version: 1,
  endpoints: [{ id: 'ep_smoke', name: '冒烟接入点', url: `ws://127.0.0.1:${PORT}`, enabled: true }],
  servers: [
    {
      id: 'srv_smoke',
      name: 'mock-mcp',
      transport: 'stdio',
      enabled: true,
      command: process.execPath,
      args: [path.join(root, 'scripts', 'mock-mcp-server.mjs')]
    },
    // 旧版本的写法：安装路径写死在配置里（这些路径当前仍然存在，所以「失效了才修」的逻辑不会动它）
    ...LEGACY_BUILTINS.map((b) => ({
      id: `srv_legacy_${b.script}`,
      name: b.name,
      transport: 'stdio',
      enabled: true,
      command: process.execPath,
      args: [path.join(root, 'servers', b.script)],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }))
  ],
  devices: [
    {
      id: 'dev_smoke',
      name: '冒烟设备',
      endpointId: 'ep_smoke',
      serverIds: ['srv_smoke'],
      autoStart: false
    }
  ],
  settings: { pythonPath: 'python', logLimit: 800, maxBackoffMs: 5000, autoStartAll: false }
}

mkdirSync(path.dirname(configPath), { recursive: true })
writeFileSync(configPath, JSON.stringify(smokeConfig, null, 2), 'utf8')
rmSync(reportPath, { force: true })

const received = []
let connections = 0
const wss = new WebSocketServer({ port: PORT })
wss.on('connection', (ws) => {
  connections += 1
  ws.send('{"jsonrpc":"2.0","id":9,"method":"ping"}')
  ws.on('message', (data) => received.push(data.toString()))
})

const userDataFlag = `--user-data-dir=${userData}`
const child = spawn(exePath, exePath === electronPath ? ['.', userDataFlag] : [userDataFlag], {
  cwd: root,
  stdio: 'ignore',
  env: {
    ...process.env,
    MCP_CONSOLE_SMOKE: reportPath,
    MCP_CONSOLE_SMOKE_FLOW: '1',
    MCP_CONSOLE_SMOKE_BUILTINS: process.env.MCP_CONSOLE_SMOKE_BUILTINS || '',
    MCP_CONSOLE_SMOKE_UI: process.env.MCP_CONSOLE_SMOKE_UI || '1',
    MCP_CONSOLE_TRACE: path.join(root, 'trace.log')
  }
})

const exited = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    child.kill()
    resolve('timeout')
  }, 90_000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolve(code ?? 0)
  })
})

wss.close()

let report = null
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch (err) {
  console.log(`无法读取冒烟报告：${err.message}（electron 退出码 ${exited}）`)
}

if (report) {
  console.log(JSON.stringify(report, null, 2))
  check('界面渲染（7 个导航项）', report.nav === 7, `nav=${report.nav}`)
  check('配置加载完成（非载入态）', report.booting === false, `booting=${report.booting}`)

  const device = report.flow?.runtime?.[0]
  check('设备运行时已创建', Boolean(device), `runtime=${JSON.stringify(device?.status)}`)
  check('设备状态 running', device?.status === 'running', `status=${device?.status}`)
  check('管道已建立', (device?.pipes?.length ?? 0) === 1, `pipes=${device?.pipes?.length ?? 0}`)
  check('接入点收到连接', connections >= 1, `connections=${connections}`)
  check('服务器回包经接入点返回', received.some((l) => l.includes('pong:')), `received=${received.length}`)
  check('界面显示运行中状态', (report.flow?.ui?.pills ?? []).some((p) => p.includes('运行中')), `pills=${JSON.stringify(report.flow?.ui?.pills)}`)

  const epTest = report.tests?.endpoint
  check('接入点测试通过', epTest?.ok === true, `result=${JSON.stringify(epTest)}`)
  const srvTest = report.tests?.server
  check('服务器测试握手通过', srvTest?.ok === true, `error=${srvTest?.error ?? '-'}`)
  check('测试拿到 serverInfo', srvTest?.serverInfo?.name === 'mock-mcp', `serverInfo=${JSON.stringify(srvTest?.serverInfo)}`)
  check('测试列出工具', (srvTest?.tools?.length ?? 0) === 2, `tools=${JSON.stringify(srvTest?.tools)}`)
  check(
    '工具自省带回参数 schema',
    report.tests?.tools?.ok === true &&
      Boolean(report.tests?.tools?.tools?.find((t) => t.name === 'echo')?.inputSchema?.properties?.text),
    `tools=${JSON.stringify(report.tests?.tools?.tools?.map((t) => t.name))}`
  )
  check(
    '调试台调用工具拿到返回',
    report.tests?.call?.ok === true && String(report.tests?.call?.text ?? '').includes('调试台冒烟'),
    `call=${JSON.stringify(report.tests?.call)}`
  )

  if (report.ui) {
    check('界面有「载入内置」按钮', report.ui.loadBtn === true, `ui=${JSON.stringify(report.ui)}`)
    check('载入内置后列表增加', (report.ui.rowsAfterLoad ?? 0) >= 4, `rows=${report.ui.rowsAfterLoad}`)
    const resolvedLines = report.ui.resolvedLines ?? []
    check(
      '服务器页显示引用解析后的实际命令',
      resolvedLines.length >= 4 && resolvedLines.every((l) => l.includes('servers')),
      `lines=${JSON.stringify(resolvedLines.map((l) => l.slice(0, 70)))}`
    )
    if (process.env.MCP_CONSOLE_EXPECT_ROOT) {
      const want = String(process.env.MCP_CONSOLE_EXPECT_ROOT).replace(/\\/g, '/')
      check(
        '界面上的实际命令跟着安装位置变',
        resolvedLines.length >= 4 && resolvedLines.every((l) => l.replace(/\\/g, '/').includes(want)),
        `want=${want}`
      )
    }
    check('界面点「测试」显示通过', (report.ui.testLines ?? []).some((l) => l.startsWith('✓')), `testLines=${JSON.stringify(report.ui.testLines)}`)
    check('新建设备弹窗自动聚焦输入框', report.ui.focusTag === 'INPUT', `focusTag=${report.ui.focusTag}`)
    check('设备名称能输入文字', report.ui.typedValue === '冒烟设备', `typedValue=${JSON.stringify(report.ui.typedValue)}`)
    const settingRows = report.ui.settingRows ?? []
    check(
      '设置页列出工具路径探测结果',
      settingRows.length >= 6 &&
        settingRows.some((t) => t.includes('Codex CLI')) &&
        settingRows.some((t) => t.includes('Python')),
      `rows=${JSON.stringify(settingRows.map((t) => t.slice(0, 40)))}`
    )
    check(
      '设置页探测接口可用',
      Number(report.ui.detectCall?.n) >= 5,
      `detectCall=${JSON.stringify(report.ui.detectCall)} rejs=${JSON.stringify(report.ui.rejs)}`
    )
  }

  if (report.builtins) {
    check('助手脚本目录存在', report.builtins.dirExists === true, `dir=${report.builtins.dir}`)
    const binfo = report.builtins.info ?? {}
    check(
      '内置脚本目录信息齐全（形态/来源/可写）',
      ['dev', 'portable', 'installed'].includes(binfo.mode) && binfo.dir === report.builtins.dir && binfo.writable === true,
      `mode=${binfo.mode} dir=${binfo.dir} source=${binfo.source}`
    )
    check(
      '便携版脚本不落在临时解压目录',
      binfo.mode !== 'portable' || !String(binfo.dir).includes('Temp'),
      `mode=${binfo.mode} dir=${binfo.dir}`
    )
    check('助手脚本齐备（4 个）', (report.builtins.scripts?.length ?? 0) === 4, `scripts=${JSON.stringify(report.builtins.scripts)}`)
    check(
      '内置服务器脚本写成可移植引用',
      (report.builtins.scripts ?? []).length === 4 &&
        (report.builtins.scripts ?? []).every((s) => /^\{servers\}\/[a-z]+\.cjs$/.test(String(s))),
      `scripts=${JSON.stringify(report.builtins.scripts)}`
    )
    const stored = report.builtins.stored ?? []
    check(
      '启动时把配置里写死的安装路径改回引用',
      stored.length === 4 &&
        stored.every((s) => s.command === '{node}' && /^\{servers\}\/[a-z]+\.cjs$/.test(String(s.args?.[0] ?? ''))),
      `stored=${JSON.stringify(stored)}`
    )
    const norm = (v) => String(v ?? '').replace(/\\/g, '/')
    check(
      '内置服务器说明文本里不再存安装路径快照',
      stored.length === 4 &&
        stored.every((s) => !/[A-Za-z]:\\/.test(String(s.note ?? '')) && !String(s.note ?? '').includes('｜脚本：')),
      `notes=${JSON.stringify(stored.map((s) => String(s.note ?? '').slice(0, 36)))}`
    )
    const expanded = report.builtins.expanded ?? []
    check(
      '引用解析到当前生效目录（换安装位置自动跟随）',
      expanded.length === 4 && expanded.every((s) => norm(s.args?.[0]).startsWith(norm(report.builtins.dir))),
      `dir=${report.builtins.dir} expanded=${JSON.stringify(expanded.map((s) => s.args?.[0]))}`
    )
    check(
      '解析后的命令与脚本真实存在',
      expanded.length === 4 && expanded.every((s) => existsSync(s.command) && existsSync(s.args?.[0])),
      `cmds=${JSON.stringify(expanded.map((s) => s.command))}`
    )
    check(
      '解析后的 env 不含残留花括号',
      expanded.every((s) => Object.values(s.env ?? {}).every((v) => !String(v).includes('{'))),
      `envs=${JSON.stringify(expanded.map((s) => s.env))}`
    )
    if (process.env.MCP_CONSOLE_EXPECT_ROOT) {
      const want = norm(process.env.MCP_CONSOLE_EXPECT_ROOT)
      check(
        '配置跟随程序被搬到新位置',
        expanded.length === 4 && expanded.every((s) => norm(s.args?.[0]).startsWith(want)),
        `want=${want} got=${JSON.stringify(expanded.map((s) => s.args?.[0]))}`
      )
    }
    check(
      '四个助手服务器握手都通过',
      (report.builtins.tests ?? []).length === 4 && (report.builtins.tests ?? []).every((t) => t?.ok === true),
      `tests=${JSON.stringify((report.builtins.tests ?? []).map((t) => ({ ok: t?.ok, tools: t?.tools, error: t?.error })))}`
    )
    const allTools = (report.builtins.tests ?? []).flatMap((t) => t?.tools ?? [])
    check('四套工具名互不重复（共 18 个）', allTools.length === 18 && new Set(allTools).size === 18, `tools=${JSON.stringify(allTools)}`)
    check(
      '工具名带助手前缀',
      ['codex', 'opencode', 'dsh'].every((n) => allTools.includes(`${n}_start`) && allTools.includes(`${n}_stop`)) &&
        allTools.includes('dabai_ask') &&
        allTools.includes('dabai_health'),
      `tools=${JSON.stringify(allTools)}`
    )
    const details = (report.builtins.tests ?? []).flatMap((t) => t?.toolDetails ?? [])
    check(
      '握手带回工具参数 schema',
      details.length === 18 && details.every((t) => t?.inputSchema?.properties),
      `withSchema=${details.filter((t) => t?.inputSchema?.properties).length}/${details.length}`
    )
    const envs = report.builtins.envs ?? []
    const injected = envs.flatMap((s) => Object.keys(s.env ?? {}).filter((k) => k.startsWith('MCP_AGENT_')))
    check(
      '内置服务器 env 带上探测到的工具路径',
      injected.length > 0,
      `envs=${JSON.stringify(envs)}`
    )
  }

  if (report.toolchain) {
    const entries = report.toolchain.entries ?? []
    check('工具链探测返回全部条目（7 个）', entries.length === 7, `ids=${JSON.stringify(entries.map((e) => e.id))}`)
    check(
      '每个条目都带来源与候选清单',
      entries.every((e) => typeof e.source === 'string' && Array.isArray(e.candidates) && e.candidates.length > 0),
      `sources=${JSON.stringify(entries.map((e) => `${e.id}:${e.source}`))}`
    )
    const python = entries.find((e) => e.id === 'python')
    check('Python 解释器探测到', python?.found === true && Boolean(python.path), `python=${JSON.stringify(python)}`)
    const node = entries.find((e) => e.id === 'node')
    check('Node 运行时探测到', node?.found === true && Boolean(node.path), `node=${node?.path}（${node?.version ?? '-'}）`)
  }
}

const failed = checks.filter((c) => !c.ok)
if (!failed.length) rmSync(userData, { recursive: true, force: true })
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length ? 1 : 0)
