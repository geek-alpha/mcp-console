export type ServerTransport = 'stdio' | 'sse' | 'http'

export interface McpServer {
  id: string
  name: string
  transport: ServerTransport
  enabled: boolean
  /** stdio */
  command?: string
  args?: string[]
  cwd?: string
  /** stdio / 所有传输共用 */
  env?: Record<string, string>
  /** sse / http */
  url?: string
  headers?: Record<string, string>
  note?: string
}

export interface Endpoint {
  id: string
  name: string
  url: string
  token?: string
  enabled: boolean
  note?: string
}

export interface Device {
  id: string
  name: string
  endpointId: string | null
  serverIds: string[]
  autoStart: boolean
  note?: string
}

export interface AppSettings {
  pythonPath: string
  logLimit: number
  maxBackoffMs: number
  autoStartAll: boolean
  /** 工具路径覆盖：工具 id（codex/opencode/dsh/python/dabaiHome/dshHome）→ 路径；留空则自动探测 */
  toolPaths?: Record<string, string>
}

export interface AppConfig {
  version: number
  endpoints: Endpoint[]
  devices: Device[]
  servers: McpServer[]
  settings: AppSettings
}

export type PipeStatus = 'stopped' | 'connecting' | 'running' | 'reconnecting' | 'error'

export interface PipeState {
  key: string
  deviceId: string
  serverId: string
  endpointUrl: string
  status: PipeStatus
  attempts: number
  pid?: number
  startedAt?: number
  lastError?: string
  sent: number
  received: number
}

export interface DeviceRuntime {
  deviceId: string
  status: PipeStatus
  pipes: PipeState[]
}

export type LogStream = 'ws-in' | 'ws-out' | 'stderr' | 'system'

export interface LogLine {
  id: number
  ts: number
  deviceId: string
  deviceName: string
  serverId: string
  serverName: string
  stream: LogStream
  text: string
}

export interface ImportedServerPreview {
  name: string
  transport: ServerTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface ImportResult {
  ok: boolean
  path?: string
  servers?: ImportedServerPreview[]
  error?: string
}

export interface EndpointTestResult {
  ok: boolean
  latencyMs: number
  detail?: string
  error?: string
}

export interface McpToolProperty {
  type?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  items?: { type?: string }
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, McpToolProperty>
    required?: string[]
  }
}

export interface ServerTestResult {
  ok: boolean
  transport: ServerTransport
  latencyMs: number
  protocolVersion?: string
  serverInfo?: { name?: string; version?: string }
  tools?: string[]
  /** 工具清单 + 参数 schema：服务器页、设备页、调试台都读它 */
  toolDetails?: McpToolInfo[]
  steps?: string[]
  stderrTail?: string[]
  error?: string
}

export interface ServerToolsResult {
  ok: boolean
  latencyMs: number
  tools: McpToolInfo[]
  error?: string
  stderrTail?: string[]
}

export interface ServerCallRequest {
  serverId: string
  tool: string
  args?: Record<string, unknown>
  timeoutMs?: number
}

export interface ServerCallResult {
  ok: boolean
  tool: string
  elapsedMs: number
  isError?: boolean
  /** content 文本能解析成 JSON 时给结构化值，否则看 text */
  result?: unknown
  text?: string
  error?: string
  stderrTail?: string[]
}

export interface PlaceholderRow {
  token: string
  value: string
  desc: string
}

/** 配置里的引用 → 当前进程解析出的真实命令（界面拿它显示「实际执行」，随安装位置变） */
export interface ResolvedServer {
  ok: boolean
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  error?: string
}

export interface BuiltinsInfo {
  mode: 'dev' | 'portable' | 'installed'
  /** 生效的脚本目录（便携版是释放出来的稳定目录） */
  dir: string
  /** 包内（开发态为项目）源目录 */
  source: string
  copied?: number
  writable: boolean
  /** 便携版 exe 所在目录 */
  portableDir?: string
  node?: string
  /** 配置里的引用 → 当前实际值：让用户看见 {node} 到底解析成了什么 */
  refs?: PlaceholderRow[]
  error?: string
}

export interface RepairBuiltinsResult {
  ok: boolean
  fixed: number
  checked: number
  mode: string
  dir: string
  node?: string
  details: string[]
  error?: string
}

export type ToolchainSource = 'setting' | 'env' | 'path' | 'common' | 'missing'

export interface ToolchainEntry {
  id: string
  label: string
  /** 写回助手服务器的环境变量名 */
  envKey: string
  kind: 'bin' | 'dir'
  found: boolean
  path?: string
  source: ToolchainSource
  /** 查过的地方：找不到时用户可以直接照抄路径 */
  candidates: string[]
  version?: string
  hint?: string
}

export interface ToolchainReport {
  platform: string
  scannedAt: string
  entries: ToolchainEntry[]
}

export interface ApplyToolchainResult {
  ok: boolean
  /** 被写入 env 的内置服务器数量 */
  updated: number
  entries?: ToolchainEntry[]
  error?: string
}

export interface LoadBuiltinsResult {
  ok: boolean
  added: number
  error?: string
}

export interface ConsoleApi {
  getConfig(): Promise<AppConfig>
  saveConfig(config: AppConfig): Promise<AppConfig>
  getRuntime(): Promise<DeviceRuntime[]>
  startDevice(deviceId: string): Promise<DeviceRuntime[]>
  stopDevice(deviceId: string): Promise<DeviceRuntime[]>
  restartDevice(deviceId: string): Promise<DeviceRuntime[]>
  startAll(): Promise<DeviceRuntime[]>
  stopAll(): Promise<DeviceRuntime[]>
  testEndpoint(endpointId: string): Promise<EndpointTestResult>
  testServer(serverId: string): Promise<ServerTestResult>
  listServerTools(serverId: string): Promise<ServerToolsResult>
  callServerTool(request: ServerCallRequest): Promise<ServerCallResult>
  loadBuiltins(): Promise<LoadBuiltinsResult>
  builtinsInfo(): Promise<BuiltinsInfo>
  resolveServer(serverId: string): Promise<ResolvedServer>
  repairBuiltins(): Promise<RepairBuiltinsResult>
  openBuiltinsDir(): Promise<void>
  detectToolchain(force?: boolean): Promise<ToolchainReport>
  applyToolchain(): Promise<ApplyToolchainResult>
  importMcpConfig(): Promise<ImportResult>
  exportMcpConfig(): Promise<{ ok: boolean; path?: string; error?: string }>
  openConfigDir(): Promise<void>
  readLogs(): Promise<LogLine[]>
  clearLogs(): Promise<void>
  onRuntime(cb: (runtime: DeviceRuntime[]) => void): () => void
  onLogs(cb: (lines: LogLine[]) => void): () => void
  onToast(cb: (message: { kind: 'info' | 'error'; text: string }) => void): () => void
  windowControl(action: 'minimize' | 'maximize' | 'close'): void
}
