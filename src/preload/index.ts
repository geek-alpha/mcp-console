import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, ConsoleApi, DeviceRuntime, LogLine, ServerCallRequest } from '../shared/types'

const api: ConsoleApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config: AppConfig) => ipcRenderer.invoke('config:save', config),
  getRuntime: () => ipcRenderer.invoke('runtime:get'),
  startDevice: (id: string) => ipcRenderer.invoke('device:start', id),
  stopDevice: (id: string) => ipcRenderer.invoke('device:stop', id),
  restartDevice: (id: string) => ipcRenderer.invoke('device:restart', id),
  startAll: () => ipcRenderer.invoke('device:startAll'),
  stopAll: () => ipcRenderer.invoke('device:stopAll'),
  testEndpoint: (id: string) => ipcRenderer.invoke('endpoint:test', id),
  testServer: (id: string) => ipcRenderer.invoke('server:test', id),
  listServerTools: (id: string) => ipcRenderer.invoke('server:tools', id),
  callServerTool: (request: ServerCallRequest) => ipcRenderer.invoke('server:call', request),
  loadBuiltins: () => ipcRenderer.invoke('builtins:load'),
  builtinsInfo: () => ipcRenderer.invoke('builtins:info'),
  resolveServer: (id: string) => ipcRenderer.invoke('server:resolve', id),
  repairBuiltins: () => ipcRenderer.invoke('builtins:repair'),
  openBuiltinsDir: () => ipcRenderer.invoke('shell:builtinsDir'),
  detectToolchain: (force?: boolean) => ipcRenderer.invoke('toolchain:detect', Boolean(force)),
  applyToolchain: () => ipcRenderer.invoke('toolchain:apply'),
  importMcpConfig: () => ipcRenderer.invoke('mcp:import'),
  exportMcpConfig: () => ipcRenderer.invoke('mcp:export'),
  openConfigDir: () => ipcRenderer.invoke('shell:configDir'),
  readLogs: () => ipcRenderer.invoke('logs:read'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  onRuntime: (cb: (runtime: DeviceRuntime[]) => void) => {
    const handler = (_e: unknown, runtime: DeviceRuntime[]) => cb(runtime)
    ipcRenderer.on('runtime', handler)
    return () => ipcRenderer.off('runtime', handler)
  },
  onLogs: (cb: (lines: LogLine[]) => void) => {
    const handler = (_e: unknown, lines: LogLine[]) => cb(lines)
    ipcRenderer.on('logs', handler)
    return () => ipcRenderer.off('logs', handler)
  },
  onToast: (cb: (message: { kind: 'info' | 'error'; text: string }) => void) => {
    const handler = (_e: unknown, message: { kind: 'info' | 'error'; text: string }) => cb(message)
    ipcRenderer.on('toast', handler)
    return () => ipcRenderer.off('toast', handler)
  },
  windowControl: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.send('window:control', action)
}

contextBridge.exposeInMainWorld('mcpConsole', api)
