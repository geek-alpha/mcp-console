import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppState } from '../state'
import { Button, Card, EmptyState } from '../components/ui'
import type { LogStream } from '../../shared/types'

const STREAMS: { value: LogStream | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'ws-in', label: '下行' },
  { value: 'ws-out', label: '上行' },
  { value: 'stderr', label: 'stderr' },
  { value: 'system', label: '系统' }
]

const STREAM_TONE: Record<LogStream, string> = {
  'ws-in': 'in',
  'ws-out': 'out',
  stderr: 'err',
  system: 'sys'
}

const STREAM_LABEL: Record<LogStream, string> = {
  'ws-in': 'IN',
  'ws-out': 'OUT',
  stderr: 'ERR',
  system: 'SYS'
}

const fmtTime = (ts: number) => {
  const d = new Date(ts)
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export default function Logs() {
  const { config, logs, clearLogs } = useAppState()
  const [deviceId, setDeviceId] = useState('all')
  const [stream, setStream] = useState<LogStream | 'all'>('all')
  const [keyword, setKeyword] = useState('')
  const [follow, setFollow] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    return logs.filter((line) => {
      if (deviceId !== 'all' && line.deviceId !== deviceId) return false
      if (stream !== 'all' && line.stream !== stream) return false
      if (needle && !line.text.toLowerCase().includes(needle) && !line.serverName.toLowerCase().includes(needle)) return false
      return true
    })
  }, [logs, deviceId, stream, keyword])

  const visible = filtered.slice(-600)

  useEffect(() => {
    if (!follow) return
    const box = boxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [visible.length, follow])

  if (!config) return null

  return (
    <Card
      title="运行日志"
      subtitle="实时显示接入点下行、服务器上行、stderr 与系统事件"
      actions={
        <>
          <Button size="sm" onClick={() => setFollow((v) => !v)}>
            {follow ? '暂停跟随' : '跟随最新'}
          </Button>
          <Button size="sm" variant="danger" onClick={() => void clearLogs()}>
            清空
          </Button>
        </>
      }
    >
      <div className="log-filters">
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          <option value="all">全部设备</option>
          {config.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select value={stream} onChange={(e) => setStream(e.target.value as LogStream | 'all')}>
          {STREAMS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="搜索内容 / 服务器名"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <span className="muted">{filtered.length} 条</span>
      </div>

      {visible.length === 0 ? (
        <EmptyState title="暂无日志" hint="启动设备后，这里会滚动显示管道里的每一条消息" />
      ) : (
        <div className="log-box" ref={boxRef}>
          {visible.map((line) => (
            <div key={line.id} className="log-line">
              <span className="log-time">{fmtTime(line.ts)}</span>
              <span className={`log-tag log-${STREAM_TONE[line.stream]}`}>{STREAM_LABEL[line.stream]}</span>
              <span className="log-src">
                {line.deviceName}
                {line.serverName !== '设备' ? ` / ${line.serverName}` : ''}
              </span>
              <span className="log-text">{line.text}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
