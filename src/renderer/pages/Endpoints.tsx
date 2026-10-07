import { useState } from 'react'
import { useAppState } from '../state'
import { Button, Card, EmptyState, Field, Modal, TestLine, Toggle } from '../components/ui'
import type { Endpoint, EndpointTestResult } from '../../shared/types'

const newId = () => `ep_${crypto.randomUUID().slice(0, 8)}`

const blank = (): Endpoint => ({
  id: newId(),
  name: '',
  url: 'ws://127.0.0.1:8765',
  token: '',
  enabled: true,
  note: ''
})

export default function Endpoints() {
  const { config, update, notify } = useAppState()
  const [draft, setDraft] = useState<Endpoint | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [tests, setTests] = useState<Record<string, EndpointTestResult | 'pending'>>({})

  if (!config) return null

  const runTest = async (endpoint: Endpoint) => {
    setTests((prev) => ({ ...prev, [endpoint.id]: 'pending' }))
    try {
      const result = await window.mcpConsole.testEndpoint(endpoint.id)
      setTests((prev) => ({ ...prev, [endpoint.id]: result }))
      notify(
        result.ok ? 'info' : 'error',
        `接入点「${endpoint.name}」${result.ok ? `连通 ${result.latencyMs} ms` : `不通：${result.error}`}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setTests((prev) => ({ ...prev, [endpoint.id]: { ok: false, latencyMs: 0, error: message } }))
      notify('error', message)
    }
  }

  const openNew = () => {
    setDraft(blank())
    setIsNew(true)
  }

  const save = () => {
    if (!draft) return
    const name = draft.name.trim()
    const url = draft.url.trim()
    if (!name || !url) {
      notify('error', '名称和地址都不能为空')
      return
    }
    if (!/^wss?:\/\//i.test(url)) {
      notify('error', '接入点地址需要以 ws:// 或 wss:// 开头')
      return
    }
    const next = { ...draft, name, url }
    update({
      endpoints: isNew ? [...config.endpoints, next] : config.endpoints.map((e) => (e.id === next.id ? next : e))
    })
    setDraft(null)
  }

  const remove = (endpoint: Endpoint) => {
    const bound = config.devices.filter((d) => d.endpointId === endpoint.id)
    if (bound.length) {
      notify('error', `还有 ${bound.length} 台设备绑定着这个接入点，先改绑再删除`)
      return
    }
    if (!window.confirm(`删除接入点「${endpoint.name}」？`)) return
    update({ endpoints: config.endpoints.filter((e) => e.id !== endpoint.id) })
  }

  const toggle = (endpoint: Endpoint, enabled: boolean) => {
    update({ endpoints: config.endpoints.map((e) => (e.id === endpoint.id ? { ...e, enabled } : e)) })
  }

  return (
    <Card
      title="接入点"
      subtitle="MCP_ENDPOINT —— 设备接入用的 WebSocket 地址，可配置多个"
      actions={
        <Button variant="primary" size="sm" onClick={openNew}>
          + 新建接入点
        </Button>
      }
    >
      {config.endpoints.length === 0 ? (
        <EmptyState title="还没有接入点" hint="至少建一个 ws:// 地址，设备才能接入" />
      ) : (
        <div className="rows">
          {config.endpoints.map((endpoint) => {
            const bound = config.devices.filter((d) => d.endpointId === endpoint.id).length
            return (
              <div key={endpoint.id} className="row">
                <div className="row-main">
                  <div className="row-title">
                    <h4>{endpoint.name}</h4>
                    <span className={`tag${endpoint.enabled ? ' tag-ok' : ''}`}>
                      {endpoint.enabled ? '启用' : '停用'}
                    </span>
                    {bound > 0 && <span className="tag">{bound} 台设备</span>}
                  </div>
                  <p className="mono muted">{endpoint.url}</p>
                  {endpoint.note && <p className="muted">{endpoint.note}</p>}
                  <TestLine result={tests[endpoint.id]} />
                </div>
                <div className="row-actions">
                  <Toggle checked={endpoint.enabled} onChange={(next) => toggle(endpoint, next)} />
                  <Button size="sm" onClick={() => void runTest(endpoint)} disabled={tests[endpoint.id] === 'pending'}>
                    {tests[endpoint.id] === 'pending' ? '测试中…' : '测试连通'}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setDraft({ ...endpoint })
                      setIsNew(false)
                    }}
                  >
                    编辑
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(endpoint)}>
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
        title={isNew ? '新建接入点' : '编辑接入点'}
        onClose={() => setDraft(null)}
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
            <Field label="名称">
              <input
                type="text"
                value={draft.name}
                placeholder="例如：本地接入点 / 云端中继"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="WebSocket 地址" hint="对应 mcp_pipe.py 里的 MCP_ENDPOINT">
              <input
                type="text"
                value={draft.url}
                placeholder="ws://127.0.0.1:8765"
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              />
            </Field>
            <Field label="访问令牌（可选）" hint="会以 Authorization: Bearer <token> 发送">
              <input
                type="text"
                value={draft.token ?? ''}
                onChange={(e) => setDraft({ ...draft, token: e.target.value })}
              />
            </Field>
            <Field label="备注">
              <input
                type="text"
                value={draft.note ?? ''}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </Field>
            <Toggle
              checked={draft.enabled}
              onChange={(next) => setDraft({ ...draft, enabled: next })}
              label="启用这个接入点"
            />
          </>
        )}
      </Modal>
    </Card>
  )
}
