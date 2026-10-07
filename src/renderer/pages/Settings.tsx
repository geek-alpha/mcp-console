import { useCallback, useEffect, useState } from 'react'
import { useAppState } from '../state'
import { Button, Card, Field, Toggle } from '../components/ui'
import type { BuiltinsInfo, ToolchainEntry, ToolchainReport } from '../../shared/types'

const MODE_LABEL: Record<BuiltinsInfo['mode'], string> = {
  dev: '开发模式（脚本就在项目里）',
  portable: '便携版（脚本已释放到稳定目录）',
  installed: '安装版（脚本随安装目录，路径稳定）'
}

const SOURCE_LABEL: Record<ToolchainEntry['source'], string> = {
  setting: '设置指定',
  env: '环境变量',
  path: 'PATH',
  common: '常见位置',
  missing: '未找到'
}

export default function Settings() {
  const { config, update, reload, notify } = useAppState()
  const [toolchain, setToolchain] = useState<ToolchainReport | null>(null)
  const [builtins, setBuiltins] = useState<BuiltinsInfo | null>(null)
  const [scanning, setScanning] = useState(false)

  const scan = useCallback(async (force = false) => {
    setScanning(true)
    try {
      setToolchain(await window.mcpConsole.detectToolchain(force))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void scan()
    void window.mcpConsole.builtinsInfo().then(setBuiltins)
  }, [scan])

  const repairBuiltins = async () => {
    const result = await window.mcpConsole.repairBuiltins()
    setBuiltins(await window.mcpConsole.builtinsInfo())
    await reload()
    if (!result.ok) {
      notify('error', result.error ?? '修复失败')
      return
    }
    if (result.checked) notify('info', result.fixed ? `${result.fixed} / ${result.checked} 个内置服务器已改回可移植引用` : `${result.checked} 个内置服务器已是可移植引用`)
    else notify('info', '还没有内置服务器，先到「MCP 服务器」载入内置')
  }

  if (!config) return null

  const { settings } = config

  const patch = (next: Partial<typeof settings>) => update({ settings: { ...settings, ...next } })

  const setToolPath = (id: string, value: string) => {
    const next = { ...(settings.toolPaths ?? {}) }
    if (value.trim()) next[id] = value.trim()
    else delete next[id]
    patch({ toolPaths: next })
  }

  const applyToolchain = async () => {
    const result = await window.mcpConsole.applyToolchain()
    if (!result.ok) {
      notify('error', result.error ?? '写入失败')
      return
    }
    if (Array.isArray(result.entries)) {
      setToolchain({ platform: toolchain?.platform ?? '', scannedAt: new Date().toISOString(), entries: result.entries })
    }
    await reload()
    notify(
      'info',
      result.updated ? `工具路径已写入 ${result.updated} 个内置服务器` : '还没有内置服务器，先到「MCP 服务器」载入内置'
    )
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

  return (
    <>
      <Card title="运行参数" subtitle="修改即保存，下一轮连接生效">
        <div className="inline-fields">
          <Field label="Python 解释器" hint="sse / http 类型靠它跑 mcp_proxy 转发；留空则用下面探测到的 Python" wide>
            <input
              type="text"
              value={settings.pythonPath}
              placeholder="python"
              onChange={(e) => patch({ pythonPath: e.target.value })}
            />
          </Field>
          <Field label="日志上限（条）">
            <input
              type="number"
              min={100}
              max={5000}
              value={settings.logLimit}
              onChange={(e) => patch({ logLimit: Math.max(100, Number(e.target.value) || 800) })}
            />
          </Field>
          <Field label="重连最大间隔（毫秒）">
            <input
              type="number"
              min={500}
              max={60000}
              step={500}
              value={settings.maxBackoffMs}
              onChange={(e) => patch({ maxBackoffMs: Math.max(500, Number(e.target.value) || 5000) })}
            />
          </Field>
        </div>
        <Toggle
          checked={settings.autoStartAll}
          onChange={(next) => patch({ autoStartAll: next })}
          label="控制台启动时自动拉起全部设备（覆盖单设备自启设置）"
        />
      </Card>

      <Card
        title="工具路径"
        subtitle="Codex / OpenCode / DSH / Python / 大白 装在哪：自动探测（设置 → 环境变量 → PATH → 常见位置），也可手填覆盖。换机器或换安装位置后重新探测即可，脚本里没有写死任何安装位置。"
        actions={
          <div className="row-actions">
            <Button size="sm" onClick={() => void scan(true)} disabled={scanning}>
              {scanning ? '探测中…' : '重新探测'}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void applyToolchain()}>
              写入内置服务器
            </Button>
          </div>
        }
      >
        <table className="table">
          <thead>
            <tr>
              <th>工具</th>
              <th>状态</th>
              <th>位置</th>
              <th>手动指定</th>
            </tr>
          </thead>
          <tbody>
            {(toolchain?.entries ?? []).map((entry) => (
              <tr key={entry.id}>
                <td>
                  <strong>{entry.label}</strong>
                  <div className="muted mono">{entry.envKey}</div>
                </td>
                <td>
                  {entry.found ? (
                    <span className="pill pill-ok">{SOURCE_LABEL[entry.source]}</span>
                  ) : (
                    <span className="pill pill-bad">未找到</span>
                  )}
                </td>
                <td>
                  {entry.path ? (
                    <span className="mono">{entry.path}</span>
                  ) : (
                    <span className="muted">{entry.hint ?? '没找到，可在右侧手填路径'}</span>
                  )}
                  {entry.version && <div className="muted mono">{entry.version}</div>}
                  {!entry.found && entry.candidates.length > 0 && (
                    <div className="muted">查过：{entry.candidates.slice(0, 3).join('、')}</div>
                  )}
                </td>
                <td>
                  <input
                    type="text"
                    value={settings.toolPaths?.[entry.id] ?? ''}
                    placeholder={entry.path ?? '留空 = 自动探测'}
                    onChange={(e) => setToolPath(entry.id, e.target.value)}
                  />
                </td>
              </tr>
            ))}
            {!toolchain && <tr><td colSpan={4} className="muted">正在探测工具路径…</td></tr>}
          </tbody>
        </table>
        <p className="muted">
          探测到的绝对路径会以环境变量形式写进内置服务器（如 MCP_AGENT_CODEX_BIN、MCP_AGENT_DABAI_HOME），
          在「MCP 服务器 → 编辑 → 环境变量」里能看到、也能改；只靠 PATH 找到的不写死，安装位置变了照样跑。
        </p>
      </Card>

      <Card
        title="内置服务器与运行时"
        subtitle="内置的 Codex / OpenCode / DSH / 大白 靠这里的脚本目录与 Node 运行时启动。配置里存的是 {node} / {servers} 这类引用，装到哪个盘、换哪台机器都由当前进程现场解析，安装路径变了也不用改配置。"
        actions={
          <div className="row-actions">
            <Button size="sm" onClick={() => void window.mcpConsole.openBuiltinsDir()}>
              打开脚本目录
            </Button>
            <Button size="sm" variant="primary" onClick={() => void repairBuiltins()}>
              检查并改回引用
            </Button>
          </div>
        }
      >
        <table className="table">
          <tbody>
            <tr>
              <td>运行形态</td>
              <td>{builtins ? MODE_LABEL[builtins.mode] : '读取中…'}</td>
            </tr>
            <tr>
              <td>脚本目录</td>
              <td className="mono">{builtins?.dir ?? '—'}</td>
            </tr>
            <tr>
              <td>包内源目录</td>
              <td className="mono">{builtins?.source ?? '—'}</td>
            </tr>
            {builtins?.portableDir && (
              <tr>
                <td>exe 所在目录</td>
                <td className="mono">{builtins.portableDir}</td>
              </tr>
            )}
            <tr>
              <td>本次释放脚本</td>
              <td>{builtins ? `${builtins.copied ?? 0} 个文件` : '—'}</td>
            </tr>
          </tbody>
        </table>
        {builtins?.refs?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>配置里的引用</th>
                <th>当前解析成</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {builtins.refs.map((row) => (
                <tr key={row.token}>
                  <td className="mono">{row.token}</td>
                  <td className="mono">{row.value}</td>
                  <td className="muted">{row.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {builtins && !builtins.writable && (
          <p className="muted">
            脚本目录写不进去（{builtins.error ?? '未知原因'}），已退回包内目录；放到可写位置（如 D 盘或用户目录）就能稳定下来。
          </p>
        )}
      </Card>

      <Card title="配置文件" subtitle="所有接入点 / 设备 / 服务器都存在这个 config.json 里">
        <div className="row-actions">
          <Button size="sm" onClick={() => void window.mcpConsole.openConfigDir()}>
            打开配置目录
          </Button>
          <Button size="sm" onClick={() => void doImport()}>
            导入 mcp_config.json
          </Button>
          <Button size="sm" onClick={() => void doExport()}>
            导出 mcp_config.json
          </Button>
        </div>
      </Card>

      <Card title="关于" subtitle="MCP Console 0.1.0">
        <p className="muted">
          一条管道 = 一台设备 × 一个 MCP 服务器 × 一个接入点，逻辑与 mcp_pipe.py 对齐：
          WebSocket 与子进程 stdio 双向转发，断线按 1s → 2s → 5s 退避重连。
        </p>
      </Card>
    </>
  )
}
