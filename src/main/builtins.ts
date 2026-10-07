import { copyFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { builtinsDir, builtinsMode, portableDir, setActiveBuiltinsDir, sourceServersDir } from './dirs'
import { refsContext } from './refs'
import { uid } from './store'
import type {
  AppSettings,
  BuiltinsInfo,
  McpServer,
  RepairBuiltinsResult,
  ToolchainEntry
} from '../shared/types'

export { builtinsDir, builtinsMode, portableDir, sourceServersDir } from './dirs'

/**
 * 内置服务器的路径写成引用而不是绝对路径：程序装到哪、换机器、换盘符，
 * 解析都由当前进程现场做，config.json 里永远不含安装位置。
 */
const NODE_REF = '{node}'
const SERVERS_REF = '{servers}'

function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a)
    const sb = statSync(b)
    return sa.size === sb.size && Math.abs(sa.mtimeMs - sb.mtimeMs) < 2000
  } catch {
    return false
  }
}

/**
 * 把包内脚本同步到稳定目录（大小/时间一致就跳过，不做无谓写盘）。
 * 便携版每次启动调用一次，脚本随包升级也会跟着更新。
 */
export function ensureBuiltins(): BuiltinsInfo {
  const source = sourceServersDir()
  const info: BuiltinsInfo = {
    mode: builtinsMode(),
    dir: builtinsDir(),
    source,
    copied: 0,
    writable: true,
    portableDir: portableDir() ?? undefined
  }
  if (info.dir === source) return info

  try {
    mkdirSync(info.dir, { recursive: true })
    const copyTree = (from: string, to: string): void => {
      mkdirSync(to, { recursive: true })
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name)
        const dst = path.join(to, entry.name)
        if (entry.isDirectory()) {
          copyTree(src, dst)
          continue
        }
        if (!entry.isFile()) continue
        if (!sameFile(src, dst)) {
          copyFileSync(src, dst)
          info.copied = (info.copied ?? 0) + 1
        }
      }
    }
    copyTree(source, info.dir)
  } catch (err) {
    info.writable = false
    info.error = err instanceof Error ? err.message : String(err)
    info.dir = source
  }
  setActiveBuiltinsDir(info.dir)
  return info
}

interface BuiltinDef {
  name: string
  script: string
  /** 这个服务器依赖的工具链条目：探测结果会写成 {tool:id} 引用，换机器重新解析 */
  tools: string[]
  note: string
  /** 历史环境变量别名 → 现在的规范名；规范名写上后清掉别名，同义的两个变量只会打架 */
  staleEnv?: Record<string, string>
}

/**
 * 内置助手服务器：codex / opencode / dsh / 大白。
 * 工具装在哪由 toolchain 探测后按引用注入——脚本和配置里都不写死安装位置。
 */
const BUILTIN_DEFS: BuiltinDef[] = [
  {
    name: 'Codex 启停',
    script: 'codex.cjs',
    tools: ['codex'],
    note: 'codex_start/stop/status/logs：给 prompt 走 codex exec，不给则需显式传 args'
  },
  {
    name: 'OpenCode 启停',
    script: 'opencode.cjs',
    tools: ['opencode'],
    note: 'opencode_start/stop/status/logs：给 prompt 走 opencode run，不给则起 headless 服务（4096）'
  },
  {
    name: 'DSH 启停',
    script: 'dsh.cjs',
    tools: ['dsh', 'dshHome'],
    note: 'dsh_start/stop/status/logs：给 prompt 走 dsh headless，不给则起 Web UI（3080）'
  },
  {
    name: '大白 交互',
    script: 'dabai.cjs',
    tools: ['python', 'dabaiHome'],
    staleEnv: { MCP_AGENT_DABAI_PYTHON: 'MCP_AGENT_PYTHON' },
    note: 'dabai_ask 起一轮就立刻回话（结果用 dabai_result 取）/ dabai_health 环境自检 / start·stop·status·logs 后台长任务'
  }
]

/** 工具路径写成 {tool:id} 引用：解析时按当前机器探测结果展开，探测不到就不注入该变量 */
function toolEnvRefs(tools: string[], entries: Map<string, ToolchainEntry>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const id of tools) {
    const entry = entries.get(id)
    if (entry?.found && entry.path) env[entry.envKey] = `{tool:${entry.id}}`
  }
  return env
}

/**
 * 说明文本里不许留绝对路径：老版本把「脚本 / 运行时 / 工具路径」快照写进 note，
 * 程序一换位置这段文字就成了误导——实时值由 UI 走解析接口显示。
 */
function stripNoteSnapshot(note: string | undefined, fallback: string): string {
  const head = (note ?? '').split('｜脚本：')[0].trim()
  return head || fallback
}

/** 生成内置服务器：command/脚本都存引用，装到哪解析到哪 */
export function builtinServers(settings: AppSettings): McpServer[] {
  const { entries } = refsContext(settings)
  return BUILTIN_DEFS.map((def) => ({
    id: uid('srv'),
    name: def.name,
    transport: 'stdio' as const,
    enabled: true,
    command: NODE_REF,
    args: [`${SERVERS_REF}/${def.script}`],
    env: { ELECTRON_RUN_AS_NODE: '1', ...toolEnvRefs([...def.tools, 'node'], entries) },
    note: def.note
  }))
}

/**
 * 规范名已经写上时，历史别名就该消失：两个变量同时存在，脚本读哪个都有一半概率是旧值。
 * 合并语义下删 key 得单独做，所以返回要摘掉的名单交给调用方。
 */
function staleEnvKeys(def: BuiltinDef, env: Record<string, string>): string[] {
  return Object.entries(def.staleEnv ?? {})
    .filter(([alias, canonical]) => alias !== canonical && Boolean(env[canonical]))
    .map(([alias]) => alias)
}

/** 把最新探测结果写回已存在的内置服务器（按名字匹配）；不是内置服务器返回 null */
export function builtinEnvPatch(
  server: McpServer,
  settings: AppSettings
): { env: Record<string, string>; drop: string[] } | null {
  const def = BUILTIN_DEFS.find((d) => d.name === server.name)
  if (!def) return null
  const { entries } = refsContext(settings)
  const env = { ELECTRON_RUN_AS_NODE: '1', ...toolEnvRefs([...def.tools, 'node'], entries) }
  return { env, drop: staleEnvKeys(def, env) }
}

export function isBuiltinServer(server: McpServer): boolean {
  return BUILTIN_DEFS.some((d) => d.name === server.name)
}

function envSame(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  const left = a ?? {}
  const keys = new Set([...Object.keys(left), ...Object.keys(b)])
  for (const key of keys) if (left[key] !== b[key]) return false
  return true
}

/**
 * 内置服务器路径自愈：把写死的绝对路径压回引用（command={node}、脚本={servers}/x.cjs）。
 * 旧版本存的是当时的安装路径，那个目录还在时旧逻辑不会修——所以这里不按「失效了没」判断，
 * 一律压回引用；用户额外加的 args 和自定义 env 原样保留。
 */
export function repairBuiltinServers(
  servers: McpServer[],
  settings: AppSettings
): { servers: McpServer[]; result: RepairBuiltinsResult } {
  const dir = builtinsDir()
  const { ctx, entries } = refsContext(settings)
  const details: string[] = []
  let fixed = 0
  let checked = 0

  const next = servers.map((server) => {
    const def = BUILTIN_DEFS.find((d) => d.name === server.name)
    if (!def) return server
    checked += 1
    const wantScript = `${SERVERS_REF}/${def.script}`
    const args = [...(server.args ?? [])]
    if (args.length === 0) args.push(wantScript)
    else args[0] = wantScript
    const env: Record<string, string> = {
      ...(server.env ?? {}),
      ELECTRON_RUN_AS_NODE: '1',
      ...toolEnvRefs([...def.tools, 'node'], entries)
    }
    for (const key of staleEnvKeys(def, env)) delete env[key]
    const note = stripNoteSnapshot(server.note, def.note)
    if (server.command === NODE_REF && server.args?.[0] === wantScript && envSame(server.env, env) && server.note === note) {
      return server
    }

    fixed += 1
    details.push(
      `${server.name}：${server.command ?? '（空）'} → ${NODE_REF}；脚本 → ${wantScript}` +
        (server.note !== note ? '；说明文本里的路径快照已清掉' : '')
    )
    return { ...server, command: NODE_REF, args, env, note }
  })

  return {
    servers: next,
    result: {
      ok: true,
      fixed,
      checked,
      mode: builtinsMode(),
      dir,
      node: ctx.node,
      details
    }
  }
}
