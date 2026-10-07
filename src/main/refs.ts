import { appPath, builtinsDir, exeDir, isPackaged } from './dirs'
import { resolveToolchain } from './toolchain'
import { PLACEHOLDER_DOC, hasPlaceholder, resolvePlaceholder, resolveTemplate, type ResolveContext } from './paths'
import type { AppSettings, McpServer, ToolchainEntry } from '../shared/types'

interface CtxCache {
  key: string
  ctx: ResolveContext
  entries: Map<string, ToolchainEntry>
}

let cached: CtxCache | null = null

function contextKey(settings: AppSettings): string {
  return JSON.stringify({
    pythonPath: settings.pythonPath ?? '',
    toolPaths: settings.toolPaths ?? {},
    serversDir: builtinsDir(),
    exe: exeDir()
  })
}

/** 解析上下文：同一份设置内复用（探测要 stat 一堆路径，不能每个服务器算一遍） */
export function refsContext(settings: AppSettings): CtxCache {
  const key = contextKey(settings)
  if (cached && cached.key === key) return cached
  const entries = new Map(resolveToolchain(settings).map((entry) => [entry.id, entry]))
  const tools: Record<string, string> = {}
  for (const [id, entry] of entries) if (entry.found && entry.path) tools[id] = entry.path
  const ctx: ResolveContext = {
    app: exeDir(),
    resources: isPackaged() ? process.resourcesPath : appPath(),
    servers: builtinsDir(),
    node: tools.node ?? process.execPath,
    python: tools.python ?? (settings.pythonPath?.trim() || 'python'),
    tools
  }
  cached = { key, ctx, entries }
  return cached
}

export function invalidateRefs(): void {
  cached = null
}

/** 解析不出来的 env 直接丢掉：宁可让脚本自己探测，也不要塞一个带花括号的假路径进去 */
function expandEnv(
  env: Record<string, string> | undefined,
  ctx: ResolveContext
): Record<string, string> | undefined {
  if (!env) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const resolved = resolveTemplate(value, ctx)
    if (hasPlaceholder(resolved)) continue
    out[key] = resolved
  }
  return out
}

/** 配置 → 真实命令：管道、连通测试、导出 mcp_config 都走这里，永远跟当前安装位置一致 */
export function expandServer(server: McpServer, settings: AppSettings): McpServer {
  const { ctx } = refsContext(settings)
  const command = server.command ? resolveTemplate(server.command, ctx) : undefined
  if (command && hasPlaceholder(command)) {
    throw new Error(`服务器「${server.name}」的 command 里有解析不出来的引用：${server.command}`)
  }
  return {
    ...server,
    command,
    args: server.args?.map((arg) => resolveTemplate(arg, ctx)),
    cwd: server.cwd ? resolveTemplate(server.cwd, ctx) : undefined,
    url: server.url ? resolveTemplate(server.url, ctx) : undefined,
    env: expandEnv(server.env, ctx),
    headers: server.headers ? expandEnv(server.headers, ctx) : undefined
  }
}

export function expandServers(servers: McpServer[], settings: AppSettings): McpServer[] {
  return servers.map((server) => expandServer(server, settings))
}

/** 占位符 → 当前实际值：设置页要把这张表摆出来，用户才敢信 */
export function resolveTable(settings: AppSettings): Array<{ token: string; value: string; desc: string }> {
  const { ctx } = refsContext(settings)
  return PLACEHOLDER_DOC.map((doc) => ({
    token: doc.token,
    value: resolvePlaceholder(doc.token, ctx) ?? '未探测到',
    desc: doc.desc
  }))
}
