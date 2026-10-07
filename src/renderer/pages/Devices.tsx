import { useState } from 'react'
import { useAppState } from '../state'
import { Button, Card, EmptyState, Field, Modal, StatusPill, Toggle } from '../components/ui'
import { ToolList } from '../components/ToolList'
import type { Device, McpServer, McpToolInfo } from '../../shared/types'

const newId = () => `dev_${crypto.randomUUID().slice(0, 8)}`

const blank = (): Device => ({
  id: newId(),
  name: '',
  endpointId: null,
  serverIds: [],
  autoStart: false,
  note: ''
})

export default function Devices() {
  const { config, runtime, update, applyRuntime, notify } = useAppState()
  const [draft, setDraft] = useState<Device | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [toolsView, setToolsView] = useState<{
    device: Device
    entries: { server: McpServer; tools: McpToolInfo[]; error?: string }[] | null
  } | null>(null)

  if (!config) return null

  const statusOf = (id: string) => runtime.find((r) => r.deviceId === id)?.status ?? 'stopped'

  /** 设备视角的工具清单：它挂载的每个服务器各拉一份 schema */
  const openTools = async (device: Device) => {
    const servers = config.servers.filter((s) => device.serverIds.includes(s.id))
    setToolsView({ device, entries: null })
    const entries = await Promise.all(
      servers.map(async (server) => {
        try {
          const result = await window.mcpConsole.listServerTools(server.id)
          return { server, tools: result.tools, error: result.ok ? undefined : result.error }
        } catch (err) {
          return { server, tools: [], error: err instanceof Error ? err.message : String(err) }
        }
      })
    )
    setToolsView({ device, entries })
  }

  const run = async (fn: () => Promise<typeof runtime>) => {
    try {
      applyRuntime(await fn())
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }

  const openNew = () => {
    setDraft({ ...blank(), endpointId: config.endpoints[0]?.id ?? null })
    setIsNew(true)
  }

  const openEdit = (device: Device) => {
    setDraft({ ...device, serverIds: [...device.serverIds] })
    setIsNew(false)
  }

  const save = () => {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      notify('error', '设备名称不能为空')
      return
    }
    const next = { ...draft, name }
    const devices = isNew
      ? [...config.devices, next]
      : config.devices.map((d) => (d.id === next.id ? next : d))
    update({ devices })
    setDraft(null)
  }

  const remove = (device: Device) => {
    if (!window.confirm(`删除设备「${device.name}」？正在运行的管道会一并停止。`)) return
    void run(() => window.mcpConsole.stopDevice(device.id))
    update({ devices: config.devices.filter((d) => d.id !== device.id) })
  }

  const toggleServer = (serverId: string) => {
    if (!draft) return
    const has = draft.serverIds.includes(serverId)
    setDraft({
      ...draft,
      serverIds: has ? draft.serverIds.filter((id) => id !== serverId) : [...draft.serverIds, serverId]
    })
  }

  return (
    <Card
      title="设备"
      subtitle="一台设备 = 一个接入点 + 一个或多个 MCP 服务器"
      actions={
        <Button variant="primary" size="sm" onClick={openNew}>
          + 新建设备
        </Button>
      }
    >
      {config.devices.length === 0 ? (
        <EmptyState title="还没有设备" hint="点「新建设备」，选好接入点再勾选要挂载的 MCP 服务器" />
      ) : (
        <div className="rows">
          {config.devices.map((device) => {
            const endpoint = config.endpoints.find((e) => e.id === device.endpointId)
            const status = statusOf(device.id)
            const isOn = status === 'running' || status === 'connecting' || status === 'reconnecting'
            return (
              <div key={device.id} className="row">
                <div className="row-main">
                  <div className="row-title">
                    <h4>{device.name}</h4>
                    <StatusPill status={status} />
                    {device.autoStart && <span className="tag">自启</span>}
                  </div>
                  <p className="muted">
                    {endpoint ? `${endpoint.name} · ${endpoint.url}` : '未绑定接入点'} · 服务器 {device.serverIds.length} 个
                  </p>
                </div>
                <div className="row-actions">
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
                  <Button size="sm" onClick={() => void openTools(device)}>
                    工具
                  </Button>
                  <Button size="sm" onClick={() => openEdit(device)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(device)}>
                    删除
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal
        open={draft !== null}
        title={isNew ? '新建设备' : '编辑设备'}
        subtitle="设备绑定接入点后，可调用它挂载的所有 MCP 服务器"
        onClose={() => setDraft(null)}
        width={620}
        footer={
          <>
            <Button onClick={() => setDraft(null)}>取消</Button>
            <Button variant="primary" onClick={save}>
              保存
            </Button>
          </>
        }
      >
        {draft && (
          <>
            <Field label="设备名称">
              <input
                type="text"
                value={draft.name}
                placeholder="例如：客厅小智音箱 / 客服机器人 A"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>

            <Field label="接入点" hint="设备通过这个 WebSocket 地址接入">
              <select
                value={draft.endpointId ?? ''}
                onChange={(e) => setDraft({ ...draft, endpointId: e.target.value || null })}
              >
                <option value="">未绑定</option>
                {config.endpoints.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.name}（{ep.url}）{ep.enabled ? '' : ' · 已停用'}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={`MCP 服务器（已选 ${draft.serverIds.length} 个）`} hint="勾选后设备可调用这些服务器的全部工具">
              {config.servers.length === 0 ? (
                <p className="muted">还没有 MCP 服务器，先去「MCP 服务器」页添加或从 mcp_config.json 导入。</p>
              ) : (
                <div className="picker">
                  {config.servers.map((server) => {
                    const checked = draft.serverIds.includes(server.id)
                    return (
                      <button
                        key={server.id}
                        type="button"
                        className={`picker-item${checked ? ' checked' : ''}`}
                        onClick={() => toggleServer(server.id)}
                      >
                        <span className="picker-box">{checked ? '✓' : ''}</span>
                        <span className="picker-text">
                          <strong>{server.name}</strong>
                          <span className="muted">
                            {server.transport === 'stdio' ? server.command : server.url}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </Field>

            <div className="inline-fields">
              <Toggle
                checked={draft.autoStart}
                onChange={(next) => setDraft({ ...draft, autoStart: next })}
                label="控制台启动时自动拉起"
              />
            </div>

            <Field label="备注">
              <input
                type="text"
                value={draft.note ?? ''}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </Field>
          </>
        )}
      </Modal>

      <Modal
        open={toolsView !== null}
        title={toolsView ? `工具 · ${toolsView.device.name}` : '工具'}
        subtitle="这台设备能调用的全部工具，来自它挂载的 MCP 服务器"
        onClose={() => setToolsView(null)}
        width={720}
        footer={<Button onClick={() => setToolsView(null)}>关闭</Button>}
      >
        {toolsView &&
          (toolsView.entries === null ? (
            <p className="muted">正在拉取工具清单…</p>
          ) : toolsView.entries.length === 0 ? (
            <p className="muted">这台设备还没挂载服务器，先编辑设备勾选几个</p>
          ) : (
            toolsView.entries.map((entry) => (
              <div key={entry.server.id} className="tools-group">
                <h4 className="tools-group-title">
                  {entry.server.name}
                  <span className="tag">{entry.tools.length} 个工具</span>
                </h4>
                {entry.error ? <p className="test-line bad">✕ {entry.error}</p> : <ToolList tools={entry.tools} />}
              </div>
            ))
          ))}
      </Modal>
    </Card>
  )
}
