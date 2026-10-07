import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { AppConfig, DeviceRuntime, LogLine } from '../shared/types'

interface Toast {
  id: number
  kind: 'info' | 'error'
  text: string
}

interface AppStateValue {
  config: AppConfig | null
  runtime: DeviceRuntime[]
  logs: LogLine[]
  toasts: Toast[]
  notify: (kind: 'info' | 'error', text: string) => void
  update: (patch: Partial<AppConfig>) => void
  reload: () => Promise<void>
  clearLogs: () => Promise<void>
  applyRuntime: (runtime: DeviceRuntime[]) => void
}

const AppStateContext = createContext<AppStateValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [runtime, setRuntime] = useState<DeviceRuntime[]>([])
  const [logs, setLogs] = useState<LogLine[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const configRef = useRef<AppConfig | null>(null)
  const toastSeq = useRef(0)

  const commit = useCallback((next: AppConfig) => {
    configRef.current = next
    setConfig(next)
  }, [])

  const notify = useCallback((kind: 'info' | 'error', text: string) => {
    const id = ++toastSeq.current
    setToasts((prev) => [...prev, { id, kind, text }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3200)
  }, [])

  const reload = useCallback(async () => {
    const [cfg, rt, history] = await Promise.all([
      window.mcpConsole.getConfig(),
      window.mcpConsole.getRuntime(),
      window.mcpConsole.readLogs()
    ])
    commit(cfg)
    setRuntime(rt)
    setLogs(history.slice(-(cfg.settings.logLimit || 800)))
  }, [commit])

  const update = useCallback(
    (patch: Partial<AppConfig>) => {
      const prev = configRef.current
      if (!prev) return
      const next = { ...prev, ...patch }
      commit(next)
      void window.mcpConsole.saveConfig(next).then((saved) => commit(saved))
    },
    [commit]
  )

  const clearLogs = useCallback(async () => {
    await window.mcpConsole.clearLogs()
    setLogs([])
  }, [])

  useEffect(() => {
    void reload()
    const offRuntime = window.mcpConsole.onRuntime((rt) => setRuntime(rt))
    const offLogs = window.mcpConsole.onLogs((lines) => {
      setLogs((prev) => {
        const limit = configRef.current?.settings.logLimit || 800
        const merged = [...prev, ...lines]
        return merged.length > limit ? merged.slice(merged.length - limit) : merged
      })
    })
    const offToast = window.mcpConsole.onToast((message) => {
      if (message.kind === 'error') notify('error', message.text)
    })
    return () => {
      offRuntime()
      offLogs()
      offToast()
    }
  }, [reload, notify])

  return (
    <AppStateContext.Provider
      value={{ config, runtime, logs, toasts, notify, update, reload, clearLogs, applyRuntime: setRuntime }}
    >
      {children}
    </AppStateContext.Provider>
  )
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState 必须在 AppProvider 内使用')
  return ctx
}

export function useDeviceStatus(deviceId: string) {
  const { runtime } = useAppState()
  return runtime.find((r) => r.deviceId === deviceId)
}
