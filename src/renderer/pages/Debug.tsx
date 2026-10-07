import { useState } from 'react'
import { useAppState } from '../state'
import { Button, Card, Field } from '../components/ui'
import type { McpServer, McpToolInfo, McpToolProperty, ServerCallResult } from '../../shared/types'

/** 表单里都是字符串，按 schema 的类型还原成 JSON 值 */
function coerce(prop: McpToolProperty | undefined, raw: string): unknown {
  if (raw.trim() === '') return undefined
  const type = prop?.type ?? 'string'
  if (type === 'number' || type === 'integer') {
    const num = Number(raw)
    return Number.isNaN(num) ? raw : num
  }
  if (type === 'boolean') return raw.trim() === 'true'
  if (type === 'array' || type === 'object') {
    try {
      return JSON.parse(raw)
    } catch {
      return type === 'array' ? raw.split('\n').map((s) => s.trim()).filter(Boolean) : raw
    }
  }
  return raw
}

export default function Debug() {
  const { config, notify } = useAppState()
  const [serverId, setServerId] = useState('')
  const [tools, setTools] = useState<McpToolInfo[] | null>(null)
  const [toolName, setToolName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [toolsError, setToolsError] = useState<string>()
  const [result, setResult] = useState<ServerCallResult | null>(null)
  const [timeoutMs, setTimeoutMs] = useState(120000)

  if (!config) return null

  const server = config.servers.find((s) => s.id === serverId) ?? null
  const tool = tools?.find((t) => t.name === toolName) ?? null
  const properties = Object.entries(tool?.inputSchema?.properties ?? {})
  const required = new Set(tool?.inputSchema?.required ?? [])

  const pickTool = (next: McpToolInfo) => {
    setToolName(next.name)
    setResult(null)
    const init: Record<string, string> = {}
    for (const [name, prop] of Object.entries(next.inputSchema?.properties ?? {})) {
      init[name] = prop?.default === undefined ? '' : String(prop.default)
    }
    setValues(init)
  }

  const selectServer = async (next: McpServer) => {
    setServerId(next.id)
    setTools(null)
    setToolsError(undefined)
    setToolName('')
    setValues({})
    setResult(null)
    setLoading(true)
    try {
      const res = await window.mcpConsole.listServerTools(next.id)
      if (!res.ok) setToolsError(res.error ?? '拉取工具清单失败')
      else {
        setTools(res.tools)
        if (res.tools.length === 1) pickTool(res.tools[0])
      }
    } catch (err) {
      setToolsError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const call = async () => {
    if (!server || !tool) return
    const args: Record<string, unknown> = {}
    for (const [name, prop] of properties) {
      const value = coerce(prop, values[name] ?? '')
      if (value !== undefined) args[name] = value
    }
    setRunning(true)
    setResult(null)
    try {
      const res = await window.mcpConsole.callServerTool({
        serverId: server.id,
        tool: tool.name,
        args,
        timeoutMs
      })
      setResult(res)
      notify(res.ok ? 'info' : 'error', `${tool.name} ${res.ok ? `${res.elapsedMs} ms 完成` : `失败：${res.error}`}`)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card
      title="调试台"
      subtitle="选服务器 → 选工具 → 按参数 schema 填值 → 真调一次，原始返回直接看"
      actions={
        <Button size="sm" onClick={() => server && void selectServer(server)} disabled={!server || loading}>
          重新拉取工具
        </Button>
      }
    >
      <div className="debug">
        <div className="debug-col">
          <h4 className="debug-col-title">服务器</h4>
          {config.servers.length === 0 ? (
            <p className="muted">先去「MCP 服务器」页添加，或点「载入内置」</p>
          ) : (
            <div className="picker">
              {config.servers.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`picker-item${item.id === serverId ? ' checked' : ''}`}
                  onClick={() => void selectServer(item)}
                >
                  <span className="picker-box">{item.id === serverId ? '✓' : ''}</span>
                  <span className="picker-text">
                    <strong>{item.name}</strong>
                    <span className="muted">{item.transport}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="debug-col">
          <h4 className="debug-col-title">工具{tools ? `（${tools.length}）` : ''}</h4>
          {loading ? (
            <p className="muted">握手拉取中…</p>
          ) : toolsError ? (
            <p className="test-line bad">✕ {toolsError}</p>
          ) : tools ? (
            <div className="tool-picker">
              {tools.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  className={`tool-pick${item.name === toolName ? ' active' : ''}`}
                  onClick={() => pickTool(item)}
                >
                  <code>{item.name}</code>
                  {item.description && <span className="muted">{item.description}</span>}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">先挑一个服务器，工具清单会自动拉过来</p>
          )}
        </div>

        <div className="debug-col">
          <h4 className="debug-col-title">参数与调用</h4>
          {!tool ? (
            <p className="muted">选一个工具后在这里填参数</p>
          ) : (
            <>
              {properties.length === 0 && <p className="muted">这个工具不需要参数，直接调。</p>}
              {properties.map(([name, prop]) => (
                <Field
                  key={name}
                  label={`${name}${required.has(name) ? ' *' : ''}`}
                  hint={prop?.description}
                >
                  <input
                    type="text"
                    value={values[name] ?? ''}
                    placeholder={prop?.type === 'boolean' ? 'true / false' : prop?.type ?? 'string'}
                    onChange={(e) => setValues((prev) => ({ ...prev, [name]: e.target.value }))}
                  />
                </Field>
              ))}

              <Field label="超时（毫秒）" hint="问答类工具给足时间，默认 120000">
                <input
                  type="number"
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(Number(e.target.value) || 120000)}
                />
              </Field>

              <div className="debug-actions">
                <Button variant="primary" onClick={() => void call()} disabled={running}>
                  {running ? '调用中…' : '调用'}
                </Button>
                {result && <span className={`tag${result.ok ? ' tag-ok' : ''}`}>{result.elapsedMs} ms</span>}
              </div>

              {result && (
                <div className="debug-result">
                  {result.error && <p className="test-line bad">✕ {result.error}</p>}
                  {result.isError && <p className="test-line bad">工具自己报了错（isError）</p>}
                  <pre className="mono">{JSON.stringify(result.result ?? result.text ?? '', null, 2)}</pre>
                  {result.stderrTail && result.stderrTail.length > 0 && (
                    <pre className="mono muted">{result.stderrTail.join('\n')}</pre>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
