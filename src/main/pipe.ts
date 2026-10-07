import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'
import { resolveServerCommand } from './spawn'
import type {
  AppSettings,
  Device,
  Endpoint,
  LogStream,
  McpServer,
  PipeState,
  PipeStatus
} from '../shared/types'

export interface PipeHooks {
  log(stream: LogStream, text: string): void
  state(state: PipeState): void
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 一条管道 = 一个设备 × 一个 MCP 服务器 × 一个接入点。
 * 逻辑对齐 mcp_pipe.py：WebSocket <-> 子进程 stdio 双向转发，断了就退避重连。
 */
export class PipeRunner {
  readonly key: string
  private ws?: WebSocket
  private child?: ChildProcessWithoutNullStreams
  private stopping = false
  private ended = false
  private timer?: NodeJS.Timeout
  private attempts = 0
  private backoff: number
  private sent = 0
  private received = 0
  private status: PipeStatus = 'stopped'
  private startedAt?: number
  private lastError?: string

  constructor(
    private readonly device: Device,
    private readonly server: McpServer,
    private readonly endpoint: Endpoint,
    private readonly settings: AppSettings,
    private readonly hooks: PipeHooks
  ) {
    this.key = `${device.id}::${server.id}`
    this.backoff = Math.max(500, Math.min(1000, settings.maxBackoffMs))
  }

  get snapshot(): PipeState {
    return {
      key: this.key,
      deviceId: this.device.id,
      serverId: this.server.id,
      endpointUrl: this.endpoint.url,
      status: this.status,
      attempts: this.attempts,
      pid: this.child?.pid,
      startedAt: this.startedAt,
      lastError: this.lastError,
      sent: this.sent,
      received: this.received
    }
  }

  start(): void {
    if (this.status !== 'stopped') return
    this.stopping = false
    void this.session()
  }

  stop(): void {
    this.stopping = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.teardown('已手动停止')
    this.status = 'stopped'
    this.attempts = 0
    this.emitState()
  }

  async restart(): Promise<void> {
    this.stop()
    await sleep(200)
    this.start()
  }

  private emitState(): void {
    this.hooks.state(this.snapshot)
  }

  private setStatus(status: PipeStatus): void {
    this.status = status
    this.emitState()
  }

  private async session(): Promise<void> {
    if (this.stopping) return
    this.ended = false
    this.setStatus(this.attempts > 0 ? 'reconnecting' : 'connecting')
    this.hooks.log('system', this.attempts > 0
      ? `第 ${this.attempts} 次重连 ${this.endpoint.url}`
      : `连接接入点 ${this.endpoint.url}`)

    try {
      const ws = await this.openSocket()
      if (this.stopping) {
        ws.close()
        return
      }
      this.ws = ws
      this.attempts = 0
      this.backoff = Math.max(500, Math.min(1000, this.settings.maxBackoffMs))
      this.spawnChild(ws)
      this.startedAt = Date.now()
      this.setStatus('running')
      this.hooks.log('system', `已连接，服务器进程 pid=${this.child?.pid ?? '-'}`)

      ws.on('message', (data: WebSocket.RawData) => {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
        this.received += 1
        this.hooks.log('ws-in', text)
        this.writeToChild(text)
      })

      ws.on('close', () => this.finish('接入点连接已关闭'))
      ws.on('error', (err: Error) => this.finish(`接入点错误：${err.message}`))
    } catch (err) {
      this.attempts += 1
      this.lastError = err instanceof Error ? err.message : String(err)
      this.hooks.log('system', `连接失败：${this.lastError}`)
      this.scheduleReconnect()
    }
  }

  private openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(this.endpoint.token ? { Authorization: `Bearer ${this.endpoint.token}` } : {}) }
      const ws = new WebSocket(this.endpoint.url, { headers, handshakeTimeout: 10_000 })
      const onError = (err: Error) => {
        ws.removeAllListeners()
        ws.terminate()
        reject(err)
      }
      ws.once('open', () => {
        ws.off('error', onError)
        resolve(ws)
      })
      ws.once('error', onError)
    })
  }

  private buildCommand(): { file: string; argv: string[]; env: NodeJS.ProcessEnv } {
    return resolveServerCommand(this.server, this.settings)
  }

  private spawnChild(ws: WebSocket): void {
    const { file, argv, env } = this.buildCommand()
    const child = spawn(file, argv, {
      env,
      cwd: this.server.cwd || undefined,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams

    this.child = child

    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', (line) => {
      if (!line.trim()) return
      this.sent += 1
      this.hooks.log('ws-out', line)
      if (ws.readyState === WebSocket.OPEN) ws.send(`${line}\n`)
    })

    const stderr = createInterface({ input: child.stderr })
    stderr.on('line', (line) => {
      if (line.trim()) this.hooks.log('stderr', line)
    })

    child.on('error', (err) => this.finish(`服务器进程启动失败：${err.message}`))
    child.on('exit', (code, signal) => {
      this.finish(`服务器进程退出（code=${code ?? '-'}${signal ? `, signal=${signal}` : ''}）`)
    })
  }

  private writeToChild(text: string): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) return
    const payload = text.endsWith('\n') ? text : `${text}\n`
    stdin.write(payload)
  }

  /** 一次会话结束：清理现场并安排重连（除非是手动停止） */
  private finish(reason: string): void {
    if (this.ended || this.stopping) return
    this.ended = true
    this.hooks.log('system', reason)
    this.lastError = reason
    this.teardown(reason)
    this.scheduleReconnect()
  }

  private teardown(reason: string): void {
    void reason
    if (this.child) {
      const child = this.child
      this.child = undefined
      try {
        child.stdin.end()
        child.kill()
      } catch {
        /* 进程可能已经退出 */
      }
    }
    if (this.ws) {
      const ws = this.ws
      this.ws = undefined
      try {
        ws.removeAllListeners()
        ws.close()
      } catch {
        /* 忽略关闭异常 */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping) return
    this.attempts += 1
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, this.settings.maxBackoffMs)
    this.setStatus('reconnecting')
    this.hooks.log('system', `${wait} ms 后重连（第 ${this.attempts} 次）`)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.session()
    }, wait)
  }
}
