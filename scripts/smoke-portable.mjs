/**
 * 便携版稳定性冒烟：portable exe 每次运行都会解压到新的 %TEMP%\<随机>\，
 * 这里验证四件事——脚本被释放到 exe 同级的稳定目录、config 里写死的安装路径被启动时改回可移植引用、
 * 引用解析到当前稳定目录、自定义（非内置）服务器的路径不被碰；顺带验证脚本被删掉后会重新释放。
 * 运行：node scripts/smoke-portable.mjs（需先 npx electron-builder --win portable）
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const exe = process.env.MCP_CONSOLE_E2E_EXE || path.join(root, 'release', 'MCP-Console-0.1.0-portable.exe')
const exeDir = path.dirname(exe)
const userData = path.join(root, '.smoke-portable-userdata')
const configPath = path.join(userData, 'config.json')
const dataDir = path.join(exeDir, 'mcp-console-data')
const stableServers = path.join(dataDir, 'servers')
const customDir = path.join(userData, 'custom')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

if (!existsSync(exe)) {
  console.log(`FAIL  找不到便携版：${exe}（先 npx electron-builder --win portable）`)
  process.exit(1)
}

/** 模拟「上次运行留下的临时解压路径」 */
const staleDir = path.join(process.env.TEMP || 'C:/Temp', 'mcp-console-stale-run', 'resources')

function writeConfig(overrides = {}) {
  const cfg = {
    version: 1,
    endpoints: [],
    devices: [],
    servers: [
      {
        id: 'srv_codex',
        name: 'Codex 启停',
        transport: 'stdio',
        enabled: true,
        command: path.join(staleDir, 'MCP Console.exe'),
        args: [path.join(staleDir, 'servers', 'codex.cjs')],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        note:
          'codex_start/stop/status/logs：给 prompt 走 codex exec' +
          `｜脚本：${path.join(staleDir, 'servers', 'codex.cjs')}` +
          `｜运行时：${path.join(staleDir, 'MCP Console.exe')}` +
          '｜工具路径：Codex CLI → C:\\nvm4w\\nodejs\\codex.cmd（PATH）',
        ...(overrides.codex ?? {})
      },
      {
        id: 'srv_dabai',
        name: '大白 交互',
        transport: 'stdio',
        enabled: true,
        command: path.join(staleDir, 'MCP Console.exe'),
        args: [path.join(staleDir, 'servers', 'dabai.cjs')],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        note: '上次运行留下的失效路径',
        ...(overrides.dabai ?? {})
      }
    ],
    settings: { pythonPath: 'python', logLimit: 800, maxBackoffMs: 5000, autoStartAll: false }
  }
  mkdirSync(userData, { recursive: true })
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
}

function run(tag) {
  const report = path.join(root, `smoke-portable-${tag}.json`)
  rmSync(report, { force: true })
  return new Promise((resolve) => {
    const child = spawn(exe, [`--user-data-dir=${userData}`], {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        MCP_CONSOLE_SMOKE: report,
        MCP_CONSOLE_SMOKE_FLOW: '1',
        MCP_CONSOLE_SMOKE_BUILTINS: '1',
        MCP_CONSOLE_SMOKE_UI: '',
        MCP_CONSOLE_TRACE: path.join(root, `smoke-portable-${tag}.trace.log`)
      }
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve(report)
    }, 120_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(report)
    })
  })
}

const readReport = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})
const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'))
const serverByName = (cfg, name) => (cfg.servers ?? []).find((s) => s.name === name)

// ── 第一轮：失效路径 → 启动自愈 + 脚本释放 ────────────────────────────────
rmSync(dataDir, { recursive: true, force: true })
writeConfig()
const report1 = readReport(await run('1'))
const cfg1 = readConfig()
const info1 = report1.builtins?.info ?? {}

check('便携形态被识别（mode=portable）', info1.mode === 'portable', `mode=${info1.mode}`)
check('exe 目录被识别为锚点', info1.portableDir === exeDir, `portableDir=${info1.portableDir}`)
check('脚本释放到 exe 同级稳定目录', info1.dir === stableServers && existsSync(stableServers) && info1.writable === true, `dir=${info1.dir}`)
check('释放出的脚本文件齐（4 个助手 + lib）', ['codex.cjs', 'opencode.cjs', 'dsh.cjs', 'dabai.cjs'].every((f) => existsSync(path.join(stableServers, f))))
check('包内临时目录不再被引用', !String(info1.dir).includes('Temp'), `source=${info1.source}`)

const codex1 = serverByName(cfg1, 'Codex 启停')
const dabai1 = serverByName(cfg1, '大白 交互')
const expanded1 = report1.builtins?.expanded ?? []
const expandedFor = (name) => expanded1.find((s) => s.name === name)
check(
  '失效的安装路径被改写成可移植引用',
  [codex1, dabai1].every((s) => /^\{servers\}\/[a-z]+\.cjs$/.test(s?.args?.[0] ?? '')) &&
    [codex1, dabai1].every((s) => s?.command === '{node}'),
  `codex→${codex1?.args?.[0]} command=${codex1?.command}`
)
check(
  '引用解析到 exe 同级的稳定目录',
  ['Codex 启停', '大白 交互'].every((n) => path.dirname(expandedFor(n)?.args?.[0] ?? '') === stableServers),
  `codex→${expandedFor('Codex 启停')?.args?.[0]}`
)
check(
  '解析出的运行时真实存在',
  ['Codex 启停', '大白 交互'].every((n) => existsSync(expandedFor(n)?.command ?? '')),
  `command=${expandedFor('Codex 启停')?.command}`
)
check(
  '说明文本里的安装路径快照被清掉',
  !String(codex1?.note ?? '').includes('｜脚本：') && !/[A-Za-z]:\\/.test(String(codex1?.note ?? '')),
  `note=${codex1?.note}`
)
check(
  '用户自己写的说明文字保留（只剥路径快照）',
  dabai1?.note === '上次运行留下的失效路径',
  `note=${dabai1?.note}`
)
const builtinTests = (report) => report.builtins?.tests ?? []
check(
  '自愈后服务器能真起（MCP 握手）',
  builtinTests(report1).length >= 4 && builtinTests(report1).every((t) => t.ok),
  `${builtinTests(report1).filter((t) => t.ok).length}/${builtinTests(report1).length} 个内置服务器`
)

// ── 第二轮：稳定目录跨运行不变 + 手改的有效路径不被覆盖 ──────────────────
const codexMtime = statSync(path.join(stableServers, 'codex.cjs')).mtimeMs
mkdirSync(customDir, { recursive: true })
const customScript = path.join(customDir, 'my-codex.cjs')
copyFileSync(path.join(stableServers, 'codex.cjs'), customScript)
writeConfig({ codex: { command: process.execPath, args: [customScript], note: '用户手改的路径' } })
const seeded = readConfig()
seeded.servers.push({
  id: 'srv_custom',
  name: '我的脚本',
  transport: 'stdio',
  enabled: true,
  command: process.execPath,
  args: [customScript]
})
writeFileSync(configPath, JSON.stringify(seeded, null, 2), 'utf8')

const report2 = readReport(await run('2'))
const cfg2 = readConfig()
const info2 = report2.builtins?.info ?? {}
const codex2 = serverByName(cfg2, 'Codex 启停')
const dabai2 = serverByName(cfg2, '大白 交互')

check('两次运行拿到同一个稳定目录', info2.dir === info1.dir, `dir=${info2.dir}`)
check('已释放的脚本不重复搬运', info2.copied === 0 && statSync(path.join(stableServers, 'codex.cjs')).mtimeMs === codexMtime, `copied=${info2.copied}`)
check(
  '内置服务器手改的路径也压回引用（永远跟随程序位置）',
  codex2?.args?.[0] === '{servers}/codex.cjs' && codex2?.command === '{node}',
  `args=${codex2?.args?.[0]} command=${codex2?.command}`
)
check(
  '自定义服务器（非内置）的绝对路径原样保留',
  serverByName(cfg2, '我的脚本')?.args?.[0] === customScript,
  `args=${serverByName(cfg2, '我的脚本')?.args?.[0]}`
)
check(
  '同一份配置里两个内置服务器都被改写成引用',
  [codex2, dabai2].every((s) => /^\{servers\}\//.test(s?.args?.[0] ?? '')),
  `dabai→${dabai2?.args?.[0]}`
)

// ── 第三轮：稳定目录里的脚本被删掉 → 重新释放 ───────────────────────────
rmSync(path.join(stableServers, 'codex.cjs'), { force: true })
const report3 = readReport(await run('3'))
const info3 = report3.builtins?.info ?? {}
check('脚本被删后会重新释放', existsSync(path.join(stableServers, 'codex.cjs')) && (info3.copied ?? 0) >= 1, `copied=${info3.copied}`)
check('重新释放后仍能起服务器', builtinTests(report3).length >= 4 && builtinTests(report3).every((t) => t.ok))

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length ? 1 : 0)
