import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings, ToolchainEntry, ToolchainReport } from '../shared/types'
import { buildSpawn } from './spawn'

/**
 * 工具链探测：把「编程 / agent 工具装在哪」变成可发现、可覆盖、可迁移的配置。
 * 优先级：设置里的显式路径 → 环境变量 → PATH → 常见安装位置；全找不到就报 missing，并列出查过的地方。
 */

interface ToolSpec {
  id: string
  label: string
  /** 与 servers/ 下助手脚本共用的环境变量名 */
  envKey: string
  kind: 'bin' | 'dir'
  /** 可执行名（不含扩展名，跨平台） */
  names?: string[]
  /** 常见安装位置，支持 ~ / %VAR% / $VAR / * */
  common?: string[]
  /** dir 型自动发现时的命中标志（任一存在即算找到） */
  markers?: string[]
  versionArgs?: string[]
  hint?: string
}

const isWin = process.platform === 'win32'

export const TOOL_SPECS: ToolSpec[] = [
  {
    id: 'node',
    label: 'Node.js 运行时',
    envKey: 'MCP_AGENT_NODE',
    kind: 'bin',
    names: ['node'],
    versionArgs: ['--version'],
    common: [
      '%ProgramFiles%/nodejs/node.exe',
      'C:/nvm4w/nodejs/node.exe',
      '%APPDATA%/nvm/node.exe',
      '%LOCALAPPDATA%/Programs/nodejs/node.exe',
      '%LOCALAPPDATA%/fnm_multishells/*/node.exe',
      '~/.volta/bin/node',
      '~/.nvm/versions/node/*/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
      '/opt/homebrew/bin/node'
    ],
    hint: '内置助手服务器（codex/opencode/dsh/大白）靠它跑；便携版找不到系统 node 时会退回内置 Electron 运行时'
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    envKey: 'MCP_AGENT_CODEX_BIN',
    kind: 'bin',
    names: ['codex'],
    versionArgs: ['--version'],
    common: [
      '%APPDATA%/npm/codex.cmd',
      '%APPDATA%/npm/codex',
      '%LOCALAPPDATA%/pnpm/codex.cmd',
      '~/.npm-global/bin/codex',
      '~/.bun/bin/codex',
      '~/.volta/bin/codex',
      '~/.local/share/pnpm/codex',
      '~/.local/bin/codex',
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex'
    ],
    hint: 'npm i -g @openai/codex；也可在设置里直接填 codex 可执行文件的完整路径'
  },
  {
    id: 'opencode',
    label: 'OpenCode CLI',
    envKey: 'MCP_AGENT_OPENCODE_BIN',
    kind: 'bin',
    names: ['opencode'],
    versionArgs: ['--version'],
    common: [
      '%LOCALAPPDATA%/opencode/opencode.exe',
      '%APPDATA%/npm/opencode.cmd',
      '~/.opencode/bin/opencode',
      '~/.bun/bin/opencode',
      '~/.local/share/pnpm/opencode',
      '~/.local/bin/opencode',
      '/usr/local/bin/opencode',
      '/opt/homebrew/bin/opencode'
    ],
    hint: '装 opencode-ai，或在设置里填 opencode 可执行文件的完整路径'
  },
  {
    id: 'dsh',
    label: 'DSH 启动器（pnpm / dsh）',
    envKey: 'MCP_AGENT_DSH_BIN',
    kind: 'bin',
    names: ['pnpm', 'dsh'],
    versionArgs: ['--version'],
    common: [
      '%APPDATA%/npm/pnpm.cmd',
      '%LOCALAPPDATA%/pnpm/pnpm.exe',
      '~/.local/share/pnpm/pnpm',
      '~/.dsh/bin/dsh',
      '~/.local/bin/dsh',
      '/usr/local/bin/pnpm',
      '/opt/homebrew/bin/pnpm'
    ],
    hint: 'dsh 是 pnpm workspace，默认用 pnpm 起；也可填 dsh 自己的可执行文件'
  },
  {
    id: 'python',
    label: 'Python 解释器',
    envKey: 'MCP_AGENT_PYTHON',
    kind: 'bin',
    names: ['python3', 'python', 'py'],
    versionArgs: ['--version'],
    common: [
      '%LOCALAPPDATA%/Programs/Python/Python*/python.exe',
      'C:/Python*/python.exe',
      '%LOCALAPPDATA%/Microsoft/WindowsApps/python.exe',
      '/usr/bin/python3',
      '/usr/local/bin/python3',
      '~/.pyenv/shims/python3',
      '/opt/homebrew/bin/python3'
    ],
    hint: 'sse / http 服务器靠它跑 mcp_proxy，大白也用它跑 dabai_cli.py'
  },
  {
    id: 'dabaiHome',
    label: '大白工作目录',
    envKey: 'MCP_AGENT_DABAI_HOME',
    kind: 'dir',
    markers: ['dabai_cli.py', 'tools/dabai_cli.py'],
    common: ['D:/AI/dabai', '%USERPROFILE%/dabai', '~/dabai', '~/projects/dabai', '~/.dabai', '~/work/dabai'],
    hint: '含 dabai_cli.py 的目录；换机器时在这里填新位置即可'
  },
  {
    id: 'dshHome',
    label: 'DSH 仓库目录',
    envKey: 'MCP_AGENT_DSH_HOME',
    kind: 'dir',
    markers: ['pnpm-workspace.yaml', 'dsh.config.json', 'package.json'],
    common: [
      'D:/ai/deepseek-harness',
      '%USERPROFILE%/deepseek-harness',
      '~/deepseek-harness',
      '~/projects/deepseek-harness',
      '~/.dsh'
    ],
    hint: 'dsh 命令必须在仓库根目录执行，换机器时在这里填新位置'
  }
]

function expand(value: string): string {
  let out = value
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1))
  out = out.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m)
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => process.env[name] ?? m)
  return out
}

function wildcardRe(part: string): RegExp {
  const escaped = part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, isWin ? 'i' : '')
}

/** 展开通配符（逐段列目录），用于 Python3xx/python.exe 这类候选 */
function expandGlob(input: string): string[] {
  const root = path.parse(input).root
  const rest = input.slice(root.length).split(/[\\/]+/).filter(Boolean)
  let current = [root]
  for (const part of rest) {
    const next: string[] = []
    for (const dir of current) {
      if (!/[*?]/.test(part)) {
        next.push(path.join(dir, part))
        continue
      }
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        names = []
      }
      const rx = wildcardRe(part)
      for (const name of names) if (rx.test(name)) next.push(path.join(dir, name))
    }
    current = next
    if (!current.length) return []
  }
  return current
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function isExec(file: string): boolean {
  if (!isFile(file)) return false
  if (isWin) return true
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** Windows 上「codex」实际是 codex.cmd / codex.exe，按 PATHEXT 试扩展名 */
function nameVariants(name: string): string[] {
  if (path.extname(name)) return [name]
  if (!isWin) return [name]
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [...exts.map((ext) => name + ext.toLowerCase()), ...exts.map((ext) => name + ext), name]
}

function findInPath(names: string[]): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const name of names) {
    for (const variant of nameVariants(name)) {
      for (const dir of dirs) {
        const full = path.join(dir, variant)
        if (isExec(full)) return full
      }
    }
  }
  return null
}

function candidatesFor(spec: ToolSpec): string[] {
  const out: string[] = []
  for (const raw of spec.common ?? []) {
    for (const expanded of expandGlob(path.resolve(expand(raw)))) {
      if (!out.includes(expanded)) out.push(expanded)
    }
  }
  return out
}

function hasMarker(dir: string, spec: ToolSpec): boolean {
  if (!isDir(dir)) return false
  const markers = spec.markers ?? []
  if (!markers.length) return true
  return markers.some((m) => existsSync(path.join(dir, m)))
}

/** 设置 / 环境变量里的值可能是「名字」（python）也可能是「路径」（D:\AI\dabai） */
function fromOverride(value: string, spec: ToolSpec): { path?: string; ok: boolean; note?: string } {
  const raw = value.trim()
  if (!raw) return { ok: false }
  if (!/[/\\]/.test(raw)) {
    const hit = findInPath([raw])
    return hit ? { path: hit, ok: true } : { ok: false, note: `PATH 里找不到 ${raw}` }
  }
  const full = path.resolve(expand(raw))
  const ok = spec.kind === 'dir' ? isDir(full) : isExec(full)
  return ok ? { path: full, ok: true } : { ok: false, note: `路径不可用：${full}` }
}

function overrideOf(settings: AppSettings, spec: ToolSpec): string | undefined {
  const fromSettings = settings.toolPaths?.[spec.id]
  if (fromSettings?.trim()) return fromSettings
  if (spec.id === 'python' && settings.pythonPath?.trim()) return settings.pythonPath
  return undefined
}

/** 同步探测（不带版本）：内置服务器生成 env 时用它，不能等子进程 */
export function resolveToolchain(settings: AppSettings): ToolchainEntry[] {
  return TOOL_SPECS.map((spec) => {
    const candidates = candidatesFor(spec)
    const base = {
      id: spec.id,
      label: spec.label,
      envKey: spec.envKey,
      kind: spec.kind,
      candidates: candidates.slice(0, 8)
    }

    const override = overrideOf(settings, spec)
    if (override) {
      const hit = fromOverride(override, spec)
      if (hit.ok && hit.path) return { ...base, found: true, path: hit.path, source: 'setting' as const }
      return { ...base, found: false, source: 'missing' as const, hint: hit.note ?? `设置值不可用：${override}` }
    }

    const fromEnv = process.env[spec.envKey]
    if (fromEnv?.trim()) {
      const hit = fromOverride(fromEnv, spec)
      if (hit.ok && hit.path) return { ...base, found: true, path: hit.path, source: 'env' as const }
      return { ...base, found: false, source: 'missing' as const, hint: `环境变量 ${spec.envKey} 不可用：${hit.note ?? fromEnv}` }
    }

    if (spec.kind === 'bin' && spec.names?.length) {
      const hit = findInPath(spec.names)
      if (hit) return { ...base, found: true, path: hit, source: 'path' as const }
    }

    for (const candidate of candidates) {
      if (spec.kind === 'dir' ? hasMarker(candidate, spec) : isExec(candidate)) {
        return { ...base, found: true, path: candidate, source: 'common' as const }
      }
    }

    return { ...base, found: false, source: 'missing' as const, hint: spec.hint }
  })
}

function probeVersion(bin: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false
    const finish = (value?: string) => {
      if (done) return
      done = true
      resolve(value)
    }
    const { file, argv } = buildSpawn(bin, args)
    const child = execFile(file, argv, { timeout: 4000, windowsHide: true, encoding: 'utf8' }, (_err, stdout, stderr) => {
      const line = `${stdout ?? ''}${stderr ?? ''}`.trim().split(/\r?\n/)[0]
      finish(line ? line.slice(0, 120) : undefined)
    })
    child.on('error', () => finish())
  })
}

// 进设置页会自动探测，而版本探测要起子进程：同一份设置 60s 内复用结果，点「重新探测」传 force 绕过
let cache: { key: string; at: number; report: ToolchainReport } | null = null
const CACHE_MS = 60_000

export async function detectToolchain(settings: AppSettings, force = false): Promise<ToolchainReport> {
  const key = JSON.stringify({ pythonPath: settings.pythonPath, toolPaths: settings.toolPaths ?? {} })
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.report

  const entries = resolveToolchain(settings)
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.found || entry.kind !== 'bin' || !entry.path) return
      const spec = TOOL_SPECS.find((s) => s.id === entry.id)
      if (!spec?.versionArgs) return
      entry.version = await probeVersion(entry.path, spec.versionArgs)
    })
  )
  const report = {
    platform: `${process.platform}-${process.arch}`,
    scannedAt: new Date().toISOString(),
    entries
  }
  cache = { key, at: Date.now(), report }
  return report
}

export function toolchainById(settings: AppSettings): Map<string, ToolchainEntry> {
  return new Map(resolveToolchain(settings).map((entry) => [entry.id, entry]))
}
