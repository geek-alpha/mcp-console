import { useState } from 'react'
import { useAppState } from './state'
import { NAV, type Tab } from './tabs'
import { Button } from './components/ui'
import Dashboard from './pages/Dashboard'
import Devices from './pages/Devices'
import Endpoints from './pages/Endpoints'
import Servers from './pages/Servers'
import Logs from './pages/Logs'
import Settings from './pages/Settings'
import Debug from './pages/Debug'
import type { DeviceRuntime } from '../shared/types'

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const { config, runtime, logs, toasts, notify, applyRuntime } = useAppState()

  if (!config) {
    return <div className="boot">正在载入控制台配置…</div>
  }

  const running = runtime.filter((r) => r.status === 'running' || r.status === 'reconnecting').length
  const activePipes = runtime.reduce((sum, r) => sum + r.pipes.filter((p) => p.status === 'running').length, 0)

  const run = async (fn: () => Promise<DeviceRuntime[]>) => {
    try {
      applyRuntime(await fn())
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }

  const counts: Record<Tab, number | null> = {
    dashboard: null,
    devices: config.devices.length,
    endpoints: config.endpoints.length,
    servers: config.servers.length,
    debug: null,
    logs: logs.length,
    settings: null
  }

  const page = (() => {
    switch (tab) {
      case 'devices':
        return <Devices />
      case 'endpoints':
        return <Endpoints />
      case 'servers':
        return <Servers />
      case 'debug':
        return <Debug />
      case 'logs':
        return <Logs />
      case 'settings':
        return <Settings />
      default:
        return <Dashboard onNavigate={setTab} />
    }
  })()

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div className="brand-text">
            <strong>MCP Console</strong>
            <span>接入点 · 设备 · 服务器</span>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${tab === item.id ? ' active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
              {counts[item.id] !== null && <span className="nav-count">{counts[item.id]}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div>
            <span className="dot dot-ok dot-live" /> {running} 台设备运行中 · {activePipes} 条管道
          </div>
          <div className="row-gap">
            <Button size="sm" variant="primary" block onClick={() => void run(() => window.mcpConsole.startAll())}>
              全部启动
            </Button>
            <Button size="sm" block onClick={() => void run(() => window.mcpConsole.stopAll())}>
              全部停止
            </Button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2>{NAV.find((n) => n.id === tab)?.label}</h2>
          <span className="spacer" />
          <div className="win-btns">
            <button type="button" className="win-btn" title="最小化" onClick={() => window.mcpConsole.windowControl('minimize')}>
              ─
            </button>
            <button type="button" className="win-btn" title="最大化" onClick={() => window.mcpConsole.windowControl('maximize')}>
              ▢
            </button>
            <button type="button" className="win-btn close" title="关闭" onClick={() => window.mcpConsole.windowControl('close')}>
              ✕
            </button>
          </div>
        </header>
        <div className="content">{page}</div>
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'error' ? ' error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
