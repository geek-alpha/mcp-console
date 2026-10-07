import { expandServer, refsContext } from './refs'
import type { AppSettings, McpServer } from '../shared/types'

function winQuote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/** .cmd/.bat（npx、pnpm 这类）在 Windows 上必须经 cmd.exe 才能起 */
export function buildSpawn(command: string, args: string[]) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const line = [command, ...args].map(winQuote).join(' ')
    return { file: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', line] }
  }
  return { file: command, argv: args }
}

/**
 * stdio 直接起本地进程；sse / http 交给 mcp_proxy 转成 stdio——
 * 这样管道和连通测试只需要处理「stdio 子进程」一种形态。
 * 命令与环境变量先过一遍引用解析：{node}/{servers}/{tool:id} 在这里变成当前机器上的真实路径。
 */
export function resolveServerCommand(server: McpServer, settings: AppSettings) {
  const resolved = expandServer(server, settings)
  const env: NodeJS.ProcessEnv = { ...process.env, ...(resolved.env ?? {}) }
  if (resolved.transport === 'stdio') {
    if (!resolved.command) throw new Error(`服务器「${resolved.name}」缺少 command`)
    const { file, argv } = buildSpawn(resolved.command, resolved.args ?? [])
    return { file, argv, env }
  }
  if (!resolved.url) throw new Error(`服务器「${resolved.name}」缺少 url`)
  const python = refsContext(settings).ctx.python
  const argv = ['-m', 'mcp_proxy']
  if (resolved.transport === 'http') argv.push('--transport', 'streamablehttp')
  for (const [k, v] of Object.entries(resolved.headers ?? {})) argv.push('-H', k, v)
  argv.push(resolved.url)
  return { file: python, argv, env }
}
