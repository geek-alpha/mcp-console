import { EventEmitter } from 'node:events'
import { PipeRunner } from './pipe'
import type { ConfigStore } from './store'
import type {
  DeviceRuntime,
  LogLine,
  LogStream,
  PipeState,
  PipeStatus
} from '../shared/types'

const STATUS_PRIORITY: Record<PipeStatus, number> = {
  error: 5,
  reconnecting: 4,
  connecting: 3,
  running: 2,
  stopped: 1
}

function aggregate(pipes: PipeState[]): PipeStatus {
  if (!pipes.length) return 'stopped'
  return pipes.reduce<PipeStatus>(
    (worst, p) => (STATUS_PRIORITY[p.status] > STATUS_PRIORITY[worst] ? p.status : worst),
    'stopped'
  )
}

export class PipeManager extends EventEmitter {
  private runners = new Map<string, PipeRunner>()
  private active = new Set<string>()
  private logs: LogLine[] = []
  private seq = 0
  private pending: LogLine[] = []
  private flushTimer?: NodeJS.Timeout
  private stateTimer?: NodeJS.Timeout

  constructor(private readonly store: ConfigStore) {
    super()
  }

  /** 设备是否处于「应运行」状态 */
  isActive(deviceId: string): boolean {
    return this.active.has(deviceId)
  }

  startDevice(deviceId: string): DeviceRuntime[] {
    this.active.add(deviceId)
    this.syncDevice(deviceId)
    return this.runtime()
  }

  stopDevice(deviceId: string): DeviceRuntime[] {
    this.active.delete(deviceId)
    this.syncDevice(deviceId)
    return this.runtime()
  }

  async restartDevice(deviceId: string): Promise<DeviceRuntime[]> {
    this.active.add(deviceId)
    const runners = [...this.runners.entries()].filter(([key]) => key.startsWith(`${deviceId}::`))
    for (const [, runner] of runners) {
      this.runners.delete(runner.key)
      runner.stop()
    }
    await new Promise((r) => setTimeout(r, 200))
    this.syncDevice(deviceId)
    return this.runtime()
  }

  startAll(): DeviceRuntime[] {
    for (const device of this.store.current.devices) this.active.add(device.id)
    this.syncAll()
    return this.runtime()
  }

  stopAll(): DeviceRuntime[] {
    this.active.clear()
    this.syncAll()
    return this.runtime()
  }

  /** 配置变更后重新对齐运行时：新增的起来、删掉的停掉 */
  syncAll(): void {
    const known = new Set(this.store.current.devices.map((d) => d.id))
    for (const key of [...this.runners.keys()]) {
      const deviceId = key.split('::')[0]
      if (!known.has(deviceId)) {
        const runner = this.runners.get(key)
        runner?.stop()
        this.runners.delete(key)
      }
    }
    for (const deviceId of known) this.syncDevice(deviceId)
  }

  private syncDevice(deviceId: string): void {
    const cfg = this.store.current
    const device = cfg.devices.find((d) => d.id === deviceId)
    const wanted = new Set<string>()

    if (device && this.active.has(deviceId)) {
      const endpoint = cfg.endpoints.find((e) => e.id === device.endpointId)
      if (!endpoint) {
        this.pushLog(device.id, device.name, '-', '设备', 'system', '未绑定接入点，已跳过启动')
      } else if (!endpoint.enabled) {
        this.pushLog(device.id, device.name, '-', '设备', 'system', `接入点「${endpoint.name}」已停用，已跳过启动`)
      } else {
        for (const serverId of device.serverIds) {
          const server = cfg.servers.find((s) => s.id === serverId)
          if (!server || !server.enabled) continue
          const key = `${deviceId}::${serverId}`
          wanted.add(key)
          if (this.runners.has(key)) continue
          const runner = new PipeRunner(device, server, endpoint, cfg.settings, {
            log: (stream, text) =>
              this.pushLog(device.id, device.name, server.id, server.name, stream, text),
            state: () => this.emitRuntime()
          })
          this.runners.set(key, runner)
          runner.start()
        }
      }
    }

    const prefix = `${deviceId}::`
    for (const [key, runner] of [...this.runners.entries()]) {
      if (key.startsWith(prefix) && !wanted.has(key)) {
        this.runners.delete(key)
        runner.stop()
      }
    }
    this.emitRuntime()
  }

  runtime(): DeviceRuntime[] {
    const cfg = this.store.current
    return cfg.devices.map((device) => {
      const pipes = [...this.runners.values()]
        .filter((r) => r.snapshot.deviceId === device.id)
        .map((r) => r.snapshot)
      return { deviceId: device.id, status: aggregate(pipes), pipes }
    })
  }

  private emitRuntime(): void {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined
      this.emit('runtime', this.runtime())
    }, 60)
  }

  private pushLog(
    deviceId: string,
    deviceName: string,
    serverId: string,
    serverName: string,
    stream: LogStream,
    text: string
  ): void {
    const line: LogLine = {
      id: ++this.seq,
      ts: Date.now(),
      deviceId,
      deviceName,
      serverId,
      serverName,
      stream,
      text
    }
    this.logs.push(line)
    const limit = this.store.current.settings.logLimit || 800
    if (this.logs.length > limit) this.logs.splice(0, this.logs.length - limit)

    this.pending.push(line)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined
        const batch = this.pending
        this.pending = []
        if (batch.length) this.emit('logs', batch)
      }, 60)
    }
  }

  /** 控制台自身的日志（不属于任何设备管道） */
  note(text: string): void {
    this.pushLog('-', '控制台', '-', '测试', 'system', text)
  }

  logsSnapshot(): LogLine[] {
    return this.logs
  }

  clearLogs(): void {
    this.logs = []
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.stateTimer) clearTimeout(this.stateTimer)
    for (const runner of this.runners.values()) runner.stop()
    this.runners.clear()
    this.active.clear()
  }
}
