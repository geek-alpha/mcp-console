import { useAppState } from '../state'
import type { Tab } from '../tabs'
import { Button, Card, Chip, EmptyState, StatusPill } from '../components/ui'

export default function Dashboard({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const { config, runtime, applyRuntime, notify } = useAppState()
  if (!config) return null

  const run = async (fn: () => Promise<typeof runtime>) => {
    try {
      applyRuntime(await fn())
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }

  const statusOf = (deviceId: string) => runtime.find((r) => r.deviceId === deviceId)
  const running = runtime.filter((r) => r.status === 'running' || r.status === 'reconnecting').length
  const pipes = runtime.reduce((sum, r) => sum + r.pipes.length, 0)
  const activePipes = runtime.reduce((sum, r) => sum + r.pipes.filter((p) => p.status === 'running').length, 0)
  const messages = runtime.reduce(
    (sum, r) => sum + r.pipes.reduce((s, p) => s + p.sent + p.received, 0),
    0
  )

  const stats = [
    { label: '设备', value: config.devices.length, hint: `${running} 台运行中` },
    { label: '活跃管道', value: activePipes, hint: `共 ${pipes} 条` },
    { label: 'MCP 服务器', value: config.servers.length, hint: `${config.servers.filter((s) => s.enabled).length} 个启用` },
    { label: '接入点', value: config.endpoints.length, hint: `${config.endpoints.filter((e) => e.enabled).length} 个启用` },
    { label: '累计消息', value: messages, hint: '收发合计' }
  ]

  return (
    <>
      <div className="stats">
        {stats.map((s) => (
          <div key={s.label} className="stat">
            <span className="stat-label">{s.label}</span>
            <strong>{s.value}</strong>
            <span className="muted">{s.hint}</span>
          </div>
        ))}
      </div>

      <Card
        title="设备总览"
        subtitle="每台设备绑定一个接入点，可挂载一个或多个 MCP 服务器"
        actions={
          <>
            <Button size="sm" onClick={() => onNavigate('devices')}>
              管理设备
            </Button>
            <Button size="sm" variant="primary" onClick={() => void run(() => window.mcpConsole.startAll())}>
              全部启动
            </Button>
            <Button size="sm" onClick={() => void run(() => window.mcpConsole.stopAll())}>
              全部停止
            </Button>
          </>
        }
      >
        {config.devices.length === 0 ? (
          <EmptyState
            title="还没有设备"
            hint="先建一个接入点，再添加设备并把 MCP 服务器挂上去"
            action={
              <Button variant="primary" size="sm" onClick={() => onNavigate('devices')}>
                添加设备
              </Button>
            }
          />
        ) : (
          <div className="device-grid">
            {config.devices.map((device) => {
              const rt = statusOf(device.id)
              const endpoint = config.endpoints.find((e) => e.id === device.endpointId)
              const servers = device.serverIds
                .map((id) => config.servers.find((s) => s.id === id))
                .filter((s): s is NonNullable<typeof s> => Boolean(s))
              const status = rt?.status ?? 'stopped'
              const isOn = status === 'running' || status === 'connecting' || status === 'reconnecting'
              return (
                <article key={device.id} className="device-card">
                  <header>
                    <div>
                      <h4>{device.name}</h4>
                      <p className="muted">
                        {endpoint ? `${endpoint.name} · ${endpoint.url}` : '未绑定接入点'}
                      </p>
                    </div>
                    <StatusPill status={status} />
                  </header>
                  <div className="chips">
                    {servers.length === 0 && <span className="muted">未挂载服务器</span>}
                    {servers.map((s) => (
                      <Chip key={s.id} tone={s.enabled ? 'accent' : 'neutral'}>
                        {s.name}
                      </Chip>
                    ))}
                  </div>
                  <footer>
                    <Button
                      size="sm"
                      variant={isOn ? 'ghost' : 'primary'}
                      onClick={() =>
                        void run(() => (isOn ? window.mcpConsole.stopDevice(device.id) : window.mcpConsole.startDevice(device.id)))
                      }
                    >
                      {isOn ? '停止' : '启动'}
                    </Button>
                    <Button size="sm" onClick={() => void run(() => window.mcpConsole.restartDevice(device.id))}>
                      重启
                    </Button>
                    <span className="spacer" />
                    <span className="muted">
                      {rt?.pipes.length ?? 0} 条管道 · {rt?.pipes.reduce((s, p) => s + p.sent + p.received, 0) ?? 0} 条消息
                    </span>
                  </footer>
                </article>
              )
            })}
          </div>
        )}
      </Card>
    </>
  )
}
