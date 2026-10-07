import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AppConfig,
  ImportedServerPreview,
  McpServer,
  ServerTransport
} from '../shared/types'

const CONFIG_VERSION = 1

export const uid = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`

export function defaultConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    endpoints: [
      {
        id: uid('ep'),
        name: '本地接入点',
        url: 'ws://127.0.0.1:8765',
        enabled: true,
        note: 'MCP_ENDPOINT 对应的 WebSocket 地址'
      }
    ],
    devices: [],
    servers: [],
    settings: {
      pythonPath: 'python',
      logLimit: 800,
      maxBackoffMs: 5000,
      autoStartAll: false
    }
  }
}

function coerceTransport(value: unknown): ServerTransport {
  const v = String(value ?? 'stdio').toLowerCase()
  if (v === 'sse') return 'sse'
  if (v === 'http' || v === 'streamablehttp') return 'http'
  return 'stdio'
}

export function normalizeConfig(raw: unknown): AppConfig {
  const base = defaultConfig()
  if (!raw || typeof raw !== 'object') return base
  const input = raw as Partial<AppConfig>
  const settings = { ...base.settings, ...(input.settings ?? {}) }
  return {
    version: CONFIG_VERSION,
    endpoints: Array.isArray(input.endpoints) ? input.endpoints.map(normalizeEndpoint) : base.endpoints,
    devices: Array.isArray(input.devices) ? input.devices.map(normalizeDevice) : [],
    servers: Array.isArray(input.servers) ? input.servers.map(normalizeServer) : [],
    settings
  }
}

function normalizeEndpoint(raw: any) {
  return {
    id: String(raw?.id ?? uid('ep')),
    name: String(raw?.name ?? '未命名接入点'),
    url: String(raw?.url ?? ''),
    token: raw?.token ? String(raw.token) : undefined,
    enabled: raw?.enabled !== false,
    note: raw?.note ? String(raw.note) : undefined
  }
}

function normalizeDevice(raw: any) {
  return {
    id: String(raw?.id ?? uid('dev')),
    name: String(raw?.name ?? '未命名设备'),
    endpointId: raw?.endpointId ? String(raw.endpointId) : null,
    serverIds: Array.isArray(raw?.serverIds) ? raw.serverIds.map(String) : [],
    autoStart: raw?.autoStart === true,
    note: raw?.note ? String(raw.note) : undefined
  }
}

export function normalizeServer(raw: any): McpServer {
  return {
    id: String(raw?.id ?? uid('srv')),
    name: String(raw?.name ?? '未命名服务器'),
    transport: coerceTransport(raw?.transport ?? raw?.type),
    enabled: raw?.enabled !== false,
    command: raw?.command ? String(raw.command) : undefined,
    args: Array.isArray(raw?.args) ? raw.args.map(String) : undefined,
    cwd: raw?.cwd ? String(raw.cwd) : undefined,
    env: raw?.env && typeof raw.env === 'object' ? stringifyValues(raw.env) : undefined,
    url: raw?.url ? String(raw.url) : undefined,
    headers: raw?.headers && typeof raw.headers === 'object' ? stringifyValues(raw.headers) : undefined,
    note: raw?.note ? String(raw.note) : undefined
  }
}

function stringifyValues(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = String(v)
  return out
}

/** 把 mcp_config.json（mcp_pipe.py 用的格式）里的 mcpServers 转成控制台服务器条目 */
export function parseMcpServers(raw: unknown): ImportedServerPreview[] {
  const cfg = raw as { mcpServers?: Record<string, any> } | null
  const servers = cfg?.mcpServers
  if (!servers || typeof servers !== 'object') return []
  const out: ImportedServerPreview[] = []
  for (const [name, entry] of Object.entries(servers)) {
    const e = (entry ?? {}) as Record<string, any>
    if (e.disabled === true) continue
    const transport = coerceTransport(e.type ?? e.transportType)
    out.push({
      name,
      transport,
      command: e.command ? String(e.command) : undefined,
      args: Array.isArray(e.args) ? e.args.map(String) : undefined,
      url: e.url ? String(e.url) : undefined,
      env: e.env && typeof e.env === 'object' ? stringifyValues(e.env) : undefined,
      headers: e.headers && typeof e.headers === 'object' ? stringifyValues(e.headers) : undefined
    })
  }
  return out
}

export function toMcpConfig(servers: McpServer[]) {
  const mcpServers: Record<string, unknown> = {}
  for (const s of servers) {
    const entry: Record<string, unknown> = { type: s.transport }
    if (s.transport === 'stdio') {
      entry.command = s.command ?? ''
      entry.args = s.args ?? []
      if (s.cwd) entry.cwd = s.cwd
    } else {
      entry.url = s.url ?? ''
      if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers
    }
    if (s.env && Object.keys(s.env).length) entry.env = s.env
    if (!s.enabled) entry.disabled = true
    mcpServers[s.name] = entry
  }
  return { mcpServers }
}

export class ConfigStore {
  readonly file: string
  private config: AppConfig = defaultConfig()

  constructor(file?: string) {
    this.file = file ?? path.join(app.getPath('userData'), 'config.json')
  }

  get current(): AppConfig {
    return this.config
  }

  async load(): Promise<AppConfig> {
    try {
      const text = await fs.readFile(this.file, 'utf8')
      this.config = normalizeConfig(JSON.parse(text))
    } catch {
      this.config = defaultConfig()
      await this.save(this.config)
    }
    return this.config
  }

  async save(next: AppConfig): Promise<AppConfig> {
    this.config = normalizeConfig(next)
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.config, null, 2), 'utf8')
    return this.config
  }

  async readExternal(filePath: string): Promise<ImportedServerPreview[]> {
    const text = await fs.readFile(filePath, 'utf8')
    return parseMcpServers(JSON.parse(text))
  }

  /** 导出给 mcp_pipe.py 用时必须展开成真实路径：外部程序不认识 {node} 这类引用 */
  async writeMcpConfig(target: string, servers: McpServer[] = this.config.servers): Promise<string> {
    const payload = toMcpConfig(servers)
    await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf8')
    return target
  }
}
