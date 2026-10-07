import type { McpToolInfo, McpToolProperty } from '../../shared/types'

const typeOf = (prop?: McpToolProperty): string => {
  const base = prop?.type ?? 'any'
  return prop?.items?.type ? `${base}<${prop.items.type}>` : base
}

/** 工具清单 + 参数表：服务器页、设备页、调试台共用同一份渲染 */
export function ToolList({ tools, empty }: { tools: McpToolInfo[]; empty?: string }) {
  if (!tools.length) return <p className="muted">{empty ?? '这个服务器没有暴露工具'}</p>

  return (
    <div className="tools">
      {tools.map((tool) => {
        const entries = Object.entries(tool.inputSchema?.properties ?? {})
        const required = new Set(tool.inputSchema?.required ?? [])
        return (
          <div key={tool.name} className="tool">
            <div className="tool-head">
              <code className="tool-name">{tool.name}</code>
              <span className="tag">{entries.length ? `${entries.length} 个参数` : '无参数'}</span>
            </div>
            {tool.description && <p className="tool-desc">{tool.description}</p>}
            {entries.length > 0 && (
              <table className="tool-params">
                <thead>
                  <tr>
                    <th>参数</th>
                    <th>类型</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(([name, prop]) => (
                    <tr key={name}>
                      <td className="mono">
                        {name}
                        {required.has(name) && <span className="req">必填</span>}
                      </td>
                      <td className="mono muted">{typeOf(prop)}</td>
                      <td className="muted">
                        {prop?.description ?? ''}
                        {prop?.default !== undefined ? `（默认 ${JSON.stringify(prop.default)}）` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
    </div>
  )
}
