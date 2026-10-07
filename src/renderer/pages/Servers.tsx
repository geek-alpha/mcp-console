import { useEffect, useState } from 'react'
import { useAppState } from '../state'
import { Button, Card, EmptyState, Field, Modal, Segmented, TestLine, Toggle } from '../components/ui'
import { ToolList } from '../components/ToolList'
import type { McpServer, McpToolInfo, ResolvedServer, ServerTestResult, ServerTransport } from '../../shared/types'

const newId = () => `srv_${crypto.randomUUID().slice(0, 8)}`

interface Draft {
  server: McpServer
  argsText: string
  envText: string
  headersText: string
}

const toLines = (obj?: Record<string, string>) =>
  Object.entries(obj ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

function parseLines(text: string, separators: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let index = -1
    for (const sep of separators) {
      const i = line.indexOf(sep)
      if (i > 0 && (index === -1 || i < index)) index = i
    }
    if (index <= 0) continue
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}

const blank = (): McpServer => ({
  id: newId(),
  name: '',
  transport: 'stdio',
  enabled: true,
  command: 'python',
  args: [],
  url: '',
  note: ''
})

const hasRef = (server: McpServer): boolean =>
  server.transport === 'stdio' &&
  [server.command, ...(server.args ?? []), ...Object.values(server.env ?? {})].some((v) => v?.includes('{'))

const cmdLine = (resolved: ResolvedServer): string =>
  [resolved.command, ...(resolved.args ?? [])].filter(Boolean).join(' ')

export default function Servers() {
  const { config, update, reload, notify } = useAppState()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [tests, setTests] = useState<Record<string, ServerTestResult | 'pending'>>({})
  const [toolView, setToolView] = useState<{
    server: McpServer
    tools: McpToolInfo[] | null
    error?: string
  } | null>(null)

  const [resolved, setResolved] = useState<Record<string, ResolvedServer>>({})

  // 引用按当前进程位置实时解析：搬了目录这里就跟着变，用户不用靠猜
  useEffect(() => {
    let alive = true
    const targets = (config?.servers ?? []).filter(hasRef)
    void Promise.all(
      targets.map(async (s) => [s.id, await window.mcpConsole.resolveServer(s.id)] as const)
    ).then((pairs) => {
      if (alive) setResolved(Object.fromEntries(pairs))
    })
    return () => {
      alive = false
    }
  }, [config])

  if (!config) return null

  /** 测试已经拿到过 schema 就直接用，没测过才现拉一次 */
  const openTools = async (server: McpServer) => {
    const cached = tests[server.id]
    const ready = cached && cached !== 'pending' && cached.ok ? cached.toolDetails : undefined
    setToolView({ server, tools: ready ?? null })
    if (ready) return
    try {
      const result = await window.mcpConsole.listServerTools(server.id)
      setToolView({ server, tools: result.tools, error: result.ok ? undefined : result.error })
    } catch (err) {
      setToolView({ server, tools: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const runTest = async (server: McpServer) => {
    setTests((prev) => ({ ...prev, [server.id]: 'pending' }))
    try {
      const result = await window.mcpConsole.testServer(server.id)
      setTests((prev) => ({ ...prev, [server.id]: result }))
      notify(
        result.ok ? 'info' : 'error',
        `服务器「${server.name}」${result.ok ? `握手成功，${result.tools?.length ?? 0} 个工具` : `测试失败：${result.error}`}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setTests((prev) => ({ ...prev, [server.id]: { ok: false, transport: server.transport, latencyMs: 0, error: message } }))
      notify('error', message)
    }
  }

  const doLoadBuiltins = async () => {
    const result = await window.mcpConsole.loadBuiltins()
    if (!result.ok) {
      notify('error', result.error ?? '载入内置服务器失败')
      return
    }
    await reload()
    notify('info', result.added ? `已载入 ${result.added} 个内置服务器` : '内置服务器已存在')
  }

  const detailOf = (result: ServerTestResult | 'pending' | undefined): string | undefined => {
    if (!result || result === 'pending' || !result.ok) return undefined
    const tools = result.tools ?? []
    const head = tools.slice(0, 3).join('、')
    const name = result.serverInfo?.name ?? 'server'
    return `${name} · ${tools.length} 个工具${head ? `：${head}${tools.length > 3 ? '…' : ''}` : ''}`
  }

  const openNew = () => {
    setDraft({ server: blank(), argsText: '', envText: '', headersText: '' })
    setIsNew(true)
  }

  const openEdit = (server: McpServer) => {
    setDraft({
      server: { ...server },
      argsText: (server.args ?? []).join('\n'),
      envText: toLines(server.env),
      headersText: toLines(server.headers)
    })
    setIsNew(false)
  }

  const save = () => {
    if (!draft) return
    const { server } = draft
    const name = server.name.trim()
    if (!name) {
      notify('error', '服务器名称不能为空')
      return
    }
    if (server.transport === 'stdio' && !server.command?.trim()) {
      notify('error', 'stdio 类型必须填启动命令')
      return
    }
    if (server.transport !== 'stdio' && !server.url?.trim()) {
      notify('error', 'sse / http 类型必须填服务地址')
      return
    }
    const next: McpServer = {
      ...server,
      name,
      args: draft.argsText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      env: parseLines(draft.envText, ['=']),
      headers: parseLines(draft.headersText, ['=', ':'])
    }
    update({
      servers: isNew ? [...config.servers, next] : config.servers.map((s) => (s.id === next.id ? next : s))
    })
    setDraft(null)
  }

  const remove = (server: McpServer) => {
    const bound = config.devices.filter((d) => d.serverIds.includes(server.id)).length
    if (!window.confirm(`删除服务器「${server.name}」？${bound ? `${bound} 台设备会解除绑定。` : ''}`)) return
    update({
      servers: config.servers.filter((s) => s.id !== server.id),
      devices: config.devices.map((d) => ({ ...d, serverIds: d.serverIds.filter((id) => id !== server.id) }))
    })
  }

  const doImport = async () => {
    const result = await window.mcpConsole.importMcpConfig()
    if (!result.ok) {
      if (result.error && result.error !== '已取消') notify('error', result.error)
      return
    }
    await reload()
    notify('info', `已导入 ${result.servers?.length ?? 0} 个服务器`)
  }

  const doExport = async () => {
    const result = await window.mcpConsole.exportMcpConfig()
    if (result.ok) notify('info', `已导出到 ${result.path}`)
    else if (result.error && result.error !== '已取消') notify('error', result.error)
  }

  const setTransport = (transport: ServerTransport) => {
    if (!draft) return
    setDraft({ ...draft, server: { ...draft.server, transport } })
  }

  return (
    <Card
      title="MCP 服务器"
      subtitle="stdio 起本地进程；sse / http 走 mcp_proxy 转发远程服务"
      actions={
        <>
          <Button size="sm" onClick={() => void doLoadBuiltins()}>
            载入内置
          </Button>
          <Button size="sm" onClick={() => void doImport()}>
            导入 mcp_config.json
          </Button>
          <Button size="sm" onClick={() => void doExport()}>
            导出
          </Button>
          <Button variant="primary" size="sm" onClick={openNew}>
            + 新建服务器
          </Button>
        </>
      }
    >
      {config.servers.length === 0 ? (
        <EmptyState
          title="还没有 MCP 服务器"
          hint="点「载入内置」加入 Codex / OpenCode / DSH 的启停服务器，也可以直接导入已有的 mcp_config.json（与 mcp_pipe.py 等客户端共用一份配置）"
          action={
            <Button size="sm" variant="primary" onClick={() => void doImport()}>
              从 mcp_config.json 导入
            </Button>
          }
        />
      ) : (
        <div className="rows">
          {config.servers.map((server) => {
            const bound = config.devices.filter((d) => d.serverIds.includes(server.id)).length
            return (
              <div key={server.id} className="row">
                <div className="row-main">
                  <div className="row-title">
                    <h4>{server.name}</h4>
                    <span className="tag">{server.transport}</span>
                    <span className={`tag${server.enabled ? ' tag-ok' : ''}`}>{server.enabled ? '启用' : '停用'}</span>
                    {bound > 0 && <span className="tag">{bound} 台设备</span>}
                  </div>
                  <p className="mono muted">
                    {server.transport === 'stdio'
                      ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
                      : server.url}
                  </p>
                  {hasRef(server) && (
                    <p className="mono muted">
                      {resolved[server.id]?.ok
                        ? `实际执行：${cmdLine(resolved[server.id])}`
                        : resolved[server.id]?.error
                          ? `解析失败：${resolved[server.id].error}`
                          : '解析中…'}
                    </p>
                  )}
                  {server.note && <p className="muted">{server.note}</p>}
                  <TestLine result={tests[server.id]} detail={detailOf(tests[server.id])} />
                </div>
                <div className="row-actions">
                  <Toggle
                    checked={server.enabled}
                    onChange={(next) =>
                      update({
                        servers: config.servers.map((s) => (s.id === server.id ? { ...s, enabled: next } : s))
                      })
                    }
                  />
                  <Button size="sm" onClick={() => void runTest(server)} disabled={tests[server.id] === 'pending'}>
                    {tests[server.id] === 'pending' ? '测试中…' : '测试'}
                  </Button>
                  <Button size="sm" onClick={() => void openTools(server)}>
                    工具
                  </Button>
                  <Button size="sm" onClick={() => openEdit(server)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(server)}>
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
        title={isNew ? '新建 MCP 服务器' : '编辑 MCP 服务器'}
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
            <Field label="名称" hint="设备日志里用它区分来源">
              <input
                type="text"
                value={draft.server.name}
                placeholder="例如：playground / 天气 / 数据库"
                onChange={(e) => setDraft({ ...draft, server: { ...draft.server, name: e.target.value } })}
              />
            </Field>

            <Field label="传输类型">
              <Segmented
                value={draft.server.transport}
                onChange={setTransport}
                options={[
                  { value: 'stdio', label: 'stdio 本地进程' },
                  { value: 'sse', label: 'SSE 远程' },
                  { value: 'http', label: 'HTTP 远程' }
                ]}
              />
            </Field>

            {draft.server.transport === 'stdio' ? (
              <>
                <Field label="启动命令" hint="例如 python / node / npx.cmd；支持 {node}、{servers}/x.cjs、{tool:codex} 这类引用，跟着当前安装位置解析">
                  <input
                    type="text"
                    value={draft.server.command ?? ''}
                    onChange={(e) => setDraft({ ...draft, server: { ...draft.server, command: e.target.value } })}
                  />
                </Field>
                <Field label="参数（每行一个）" hint="对应 mcp_config.json 里的 args">
                  <textarea
                    value={draft.argsText}
                    placeholder={'-m\nplayground'}
                    onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
                  />
                </Field>
                <Field label="工作目录（可选）">
                  <input
                    type="text"
                    value={draft.server.cwd ?? ''}
                    placeholder="C:\\work\\my-mcp-server"
                    onChange={(e) => setDraft({ ...draft, server: { ...draft.server, cwd: e.target.value } })}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="服务地址">
                  <input
                    type="text"
                    value={draft.server.url ?? ''}
                    placeholder="https://example.com/mcp"
                    onChange={(e) => setDraft({ ...draft, server: { ...draft.server, url: e.target.value } })}
                  />
                </Field>
                <Field label="请求头（每行 Key=Value）" hint="例如 Authorization=Bearer xxx">
                  <textarea
                    value={draft.headersText}
                    onChange={(e) => setDraft({ ...draft, headersText: e.target.value })}
                  />
                </Field>
              </>
            )}

            <Field
              label="环境变量（每行 KEY=VALUE）"
              hint="内置服务器的工具路径（MCP_AGENT_CODEX_BIN / MCP_AGENT_DABAI_HOME 等）由「设置 → 工具路径」探测后写入，这里可改可覆盖"
            >
              <textarea
                value={draft.envText}
                placeholder="MCP_ENDPOINT=ws://127.0.0.1:8765"
                onChange={(e) => setDraft({ ...draft, envText: e.target.value })}
              />
            </Field>

            <Toggle
              checked={draft.server.enabled}
              onChange={(next) => setDraft({ ...draft, server: { ...draft.server, enabled: next } })}
              label="启用这个服务器"
            />
          </>
        )}
      </Modal>

      <Modal
        open={toolView !== null}
        title={toolView ? `工具 · ${toolView.server.name}` : '工具'}
        subtitle="这个服务器暴露的工具与参数，端侧调用时按这份 schema 传参"
        onClose={() => setToolView(null)}
        width={680}
        footer={<Button onClick={() => setToolView(null)}>关闭</Button>}
      >
        {toolView &&
          (toolView.error ? (
            <p className="test-line bad">✕ {toolView.error}</p>
          ) : toolView.tools ? (
            <ToolList tools={toolView.tools} />
          ) : (
            <p className="muted">正在拉取工具清单…</p>
          ))}
      </Modal>
    </Card>
  )
}
