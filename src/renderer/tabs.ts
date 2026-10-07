export type Tab = 'dashboard' | 'devices' | 'endpoints' | 'servers' | 'debug' | 'logs' | 'settings'

export const NAV: { id: Tab; label: string; icon: string }[] = [
  { id: 'dashboard', label: '概览', icon: '◈' },
  { id: 'devices', label: '设备', icon: '▤' },
  { id: 'endpoints', label: '接入点', icon: '⇄' },
  { id: 'servers', label: 'MCP 服务器', icon: '⬡' },
  { id: 'debug', label: '调试台', icon: '⌘' },
  { id: 'logs', label: '运行日志', icon: '≡' },
  { id: 'settings', label: '设置', icon: '⚙' }
]
