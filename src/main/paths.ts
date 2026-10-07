/**
 * 配置里存「引用」而不是绝对路径：程序装到哪、盘符怎么变、换台机器，
 * 路径都由当前进程现场解析，配置文件一个字都不用改。
 * 例：内置服务器 command={node}、args={servers}/codex.cjs。
 */
export interface ResolveContext {
  /** 本程序所在目录 */
  app: string
  /** 本程序资源目录（打包后是 resources） */
  resources: string
  /** 助手脚本目录 */
  servers: string
  /** JS 运行时 */
  node: string
  /** Python 解释器 */
  python: string
  /** 工具 id → 探测到的路径 */
  tools: Record<string, string>
}

export interface PlaceholderDoc {
  token: string
  desc: string
}

export const PLACEHOLDER_DOC: PlaceholderDoc[] = [
  { token: '{node}', desc: 'JS 运行时：优先系统 node，找不到则用本程序（内置 Electron）' },
  { token: '{servers}', desc: '助手脚本目录（便携版是 exe 同级的稳定目录）' },
  { token: '{app}', desc: '本程序所在目录' },
  { token: '{resources}', desc: '本程序资源目录' },
  { token: '{python}', desc: 'Python 解释器' },
  { token: '{tool:codex}', desc: '工具探测结果，id 见工具链表：codex / opencode / dsh / python / dshHome / dabaiHome / node' }
]

const TOKEN_SRC = '\\{[a-zA-Z]+(?::[A-Za-z0-9_.\\-]+)?\\}'
const TOKEN_RE = new RegExp(TOKEN_SRC, 'g')
const TOKEN_TEST = new RegExp(TOKEN_SRC)

export function hasPlaceholder(value?: string): boolean {
  return Boolean(value && TOKEN_TEST.test(value))
}

export function resolvePlaceholder(token: string, ctx: ResolveContext): string | null {
  const inner = token.slice(1, -1)
  if (inner === 'app') return ctx.app
  if (inner === 'resources') return ctx.resources
  if (inner === 'servers') return ctx.servers
  if (inner === 'node') return ctx.node
  if (inner === 'python') return ctx.python
  if (inner.startsWith('tool:')) return ctx.tools[inner.slice(5)] ?? null
  return null
}

/** 认识的占位符换成实际路径；不认识的（用户自己写的花括号）原样留着 */
export function resolveTemplate(value: string, ctx: ResolveContext): string {
  return value.replace(TOKEN_RE, (whole) => resolvePlaceholder(whole, ctx) ?? whole)
}

/** 路径比较：Windows 大小写不敏感、斜杠统一 */
export function samePath(a?: string, b?: string): boolean {
  if (!a || !b) return false
  const norm = (v: string) => v.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b)
}
