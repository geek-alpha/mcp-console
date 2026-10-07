import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'
import { resolveServerCommand } from './spawn'
import type {
  AppSettings,
  Endpoint,
  EndpointTestResult,
  McpServer,
  McpToolInfo,
  ServerCallResult,
  ServerTestResult,
  ServerToolsResult
} from '../shared/types'

const CLIENT_INFO = { name: 'mcp-console', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'

/** 握手成功后保持这么久不被对端关掉，就算接入点可用 */
const ENDPOINT_HOLD_MS = 400

export function testEndpoint(endpoint: Endpoint, timeoutMs = 8000): Promise<EndpointTestResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const headers: Record<string, string> = endpoint.token
      ? { Authorization: `Bearer ${endpoint.token}` }
      : {}
    let settled = false
    let probe: NodeJS.Timeout | undefined

    const done = (result: EndpointTestResult): void => {
      if (settled) return
      settled = true
      if (probe) clearTimeout(probe)
      clearTimeout(timer)
      try {
        ws.removeAllListeners()
        ws.terminate()
      } catch {
        /* 已断开 */
      }
      resolve(result)
    }

    const ws = new WebSocket(endpoint.url, { headers, handshakeTimeout: timeoutMs })
    const timer = setTimeout(
      () => done({ ok: false, error: `握手超时（${timeoutMs} ms）`, latencyMs: Date.now() - started }),
      timeoutMs + 500
    )

    ws.once('open', () => {
      const latencyMs = Date.now() - started
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'console-probe', method: 'ping' }))
      probe = setTimeout(
        () => done({ ok: true, latencyMs, detail: '连接正常，对端未回探测包（中继常见行为）' }),
        ENDPOINT_HOLD_MS
      )
      ws.on('message', (data) => {
        done({ ok: true, latencyMs, detail: `连接正常，回包：${String(data).slice(0, 120)}` })
      })
    })

    ws.once('error', (err: Error) =>
      done({ ok: false, error: err.message, latencyMs: Date.now() - started })
    )

    ws.once('close', (code: number, reason: Buffer) => {
      const tail = reason?.length ? ` ${reason.toString()}` : ''
      done({
        ok: false,
        error: `连接被对端关闭（code=${code}${tail}）`,
        latencyMs: Date.now() - started
      })
    })
  })
}

/** 起子进程 + 建 JSON-RPC 通道。sse / http 已在 resolveServerCommand 里转成 stdio 形态 */
interface Channel {
  request: (id: string, method: string, params?: unknown) => Promise<any>
  notify: (method: string) => void
  stderrTail: string[]
  steps: string[]
  close: () => void
}

function openChannel(server: McpServer, settings: AppSettings, timeoutMs: number): Channel {
  const steps: string[] = []
  const stderrTail: string[] = []
  const { file, argv, env } = resolveServerCommand(server, settings)
  steps.push(`启动 ${[file, ...argv].join(' ')}`)
  const child = spawn(file, argv, {
    env,
    cwd: server.cwd || undefined,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams

  const pending = new Map<
    string,
    { resolve: (msg: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >()
  let closed = false

  const failAll = (err: Error): void => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    pending.clear()
  }

  const stdout = createInterface({ input: child.stdout })
  stdout.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let msg: any
    try {
      msg = JSON.parse(text)
    } catch {
      // 子进程往 stdout 打日志是常见情况，不算错误
      return
    }
    const id = msg?.id === undefined || msg?.id === null ? null : String(msg.id)
    const waiter = id ? pending.get(id) : undefined
    if (waiter && id) {
      pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.resolve(msg)
    }
  })

  const stderr = createInterface({ input: child.stderr })
  stderr.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    stderrTail.push(text)
    if (stderrTail.length > 8) stderrTail.shift()
  })

  child.on('error', (err) => failAll(new Error(`进程启动失败：${err.message}`)))
  child.on('exit', (code, signal) =>
    failAll(new Error(`进程提前退出（code=${code ?? '-'}${signal ? `, signal=${signal}` : ''}）`))
  )

  const request = (id: string, method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} 无响应（${timeoutMs} ms）`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (msg) =>
          msg.error ? reject(new Error(`${method} 返回错误：${JSON.stringify(msg.error)}`)) : resolve(msg.result),
        reject,
        timer
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  return {
    request,
    notify: (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    stderrTail,
    steps,
    close: () => {
      if (closed) return
      closed = true
      try {
        child.stdin.end()
        child.kill()
      } catch {
        /* 进程可能已经退出 */
      }
    }
  }
}

/** initialize + notifications/initialized */
async function handshake(ch: Channel): Promise<any> {
  const init = await ch.request('console-init', 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO
  })
  const name = init?.serverInfo?.name ?? '未命名'
  const version = init?.serverInfo?.version ? ` v${init.serverInfo.version}` : ''
  ch.steps.push(`initialize 成功：${name}${version}（协议 ${init?.protocolVersion ?? '未声明'}）`)
  ch.notify('notifications/initialized')
  return init
}

/** tools/list 的原始返回 → 归一化，保留参数 schema（工具清单与调试台都靠它） */
export function normalizeTools(list: any): McpToolInfo[] {
  if (!Array.isArray(list?.tools)) return []
  return list.tools.map((t: any) => ({
    name: String(t?.name ?? '?'),
    description: typeof t?.description === 'string' ? t.description : undefined,
    inputSchema:
      t?.inputSchema && typeof t.inputSchema === 'object'
        ? {
            type: typeof t.inputSchema.type === 'string' ? t.inputSchema.type : 'object',
            properties: t.inputSchema.properties ?? {},
            required: Array.isArray(t.inputSchema.required) ? t.inputSchema.required.map(String) : []
          }
        : { type: 'object', properties: {}, required: [] }
  }))
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** 起进程 → MCP initialize 握手 → tools/list，三步都过才算测通 */
export function testServer(
  server: McpServer,
  settings: AppSettings,
  timeoutMs = 20000
): Promise<ServerTestResult> {
  const started = Date.now()
  let ch: Channel
  try {
    ch = openChannel(server, settings, timeoutMs)
  } catch (err) {
    return Promise.resolve({
      ok: false,
      transport: server.transport,
      error: errText(err),
      steps: [],
      stderrTail: [],
      latencyMs: Date.now() - started
    })
  }

  return (async (): Promise<ServerTestResult> => {
    try {
      const init = await handshake(ch)
      const details = normalizeTools(await ch.request('console-tools', 'tools/list', {}))
      ch.steps.push(`tools/list 成功：${details.length} 个工具`)
      return {
        ok: true,
        transport: server.transport,
        protocolVersion: init?.protocolVersion,
        serverInfo: { name: init?.serverInfo?.name, version: init?.serverInfo?.version },
        tools: details.map((t) => t.name),
        toolDetails: details,
        steps: ch.steps,
        stderrTail: ch.stderrTail,
        latencyMs: Date.now() - started
      }
    } catch (err) {
      return {
        ok: false,
        transport: server.transport,
        error: errText(err),
        steps: ch.steps,
        stderrTail: ch.stderrTail,
        latencyMs: Date.now() - started
      }
    } finally {
      ch.close()
    }
  })()
}

/** 只要工具清单与参数 schema：服务器页、设备页、调试台共用 */
export async function listServerTools(
  server: McpServer,
  settings: AppSettings,
  timeoutMs = 20000
): Promise<ServerToolsResult> {
  const started = Date.now()
  let ch: Channel
  try {
    ch = openChannel(server, settings, timeoutMs)
  } catch (err) {
    return { ok: false, tools: [], latencyMs: 0, error: errText(err) }
  }
  try {
    await handshake(ch)
    const tools = normalizeTools(await ch.request('console-tools', 'tools/list', {}))
    return { ok: true, tools, latencyMs: Date.now() - started, stderrTail: ch.stderrTail }
  } catch (err) {
    return {
      ok: false,
      tools: [],
      latencyMs: Date.now() - started,
      error: errText(err),
      stderrTail: ch.stderrTail
    }
  } finally {
    ch.close()
  }
}

/** 真调一个工具（调试台主入口）：起进程 → 握手 → tools/call → 收工 */
export async function callServerTool(
  server: McpServer,
  settings: AppSettings,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 120000
): Promise<ServerCallResult> {
  const started = Date.now()
  let ch: Channel
  try {
    ch = openChannel(server, settings, timeoutMs)
  } catch (err) {
    return { ok: false, tool, elapsedMs: 0, error: errText(err) }
  }
  try {
    await handshake(ch)
    const res = await ch.request('console-call', 'tools/call', { name: tool, arguments: args ?? {} })
    const text = Array.isArray(res?.content)
      ? res.content.map((c: any) => String(c?.text ?? '')).join('\n')
      : ''
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    return {
      ok: res?.isError !== true,
      tool,
      elapsedMs: Date.now() - started,
      isError: res?.isError === true,
      result: parsed,
      text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
      stderrTail: ch.stderrTail
    }
  } catch (err) {
    return {
      ok: false,
      tool,
      elapsedMs: Date.now() - started,
      error: errText(err),
      stderrTail: ch.stderrTail
    }
  } finally {
    ch.close()
  }
}
