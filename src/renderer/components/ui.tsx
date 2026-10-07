import { useEffect, useRef, type ReactNode } from 'react'
import type { PipeStatus } from '../../shared/types'

export const STATUS_META: Record<PipeStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = {
  running: { label: '运行中', tone: 'ok' },
  connecting: { label: '连接中', tone: 'warn' },
  reconnecting: { label: '重连中', tone: 'warn' },
  error: { label: '异常', tone: 'bad' },
  stopped: { label: '已停止', tone: 'idle' }
}

export function StatusDot({ status }: { status: PipeStatus }) {
  const tone = STATUS_META[status]?.tone ?? 'idle'
  return <span className={`dot dot-${tone}${status === 'running' || status === 'reconnecting' ? ' dot-live' : ''}`} />
}

export function StatusPill({ status }: { status: PipeStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.stopped
  return (
    <span className={`pill pill-${meta.tone}`}>
      <StatusDot status={status} />
      {meta.label}
    </span>
  )
}

type ButtonProps = {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger' | 'soft'
  size?: 'md' | 'sm'
  disabled?: boolean
  title?: string
  block?: boolean
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  size = 'md',
  disabled,
  title,
  block
}: ButtonProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`btn btn-${variant} btn-${size}${block ? ' btn-block' : ''}`}
    >
      {children}
    </button>
  )
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = ''
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Field({
  label,
  hint,
  children,
  wide
}: {
  label: string
  hint?: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <label className={`field${wide ? ' field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
}) {
  return (
    <button type="button" className={`toggle${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      {label && <span className="toggle-label">{label}</span>}
    </button>
  )
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560
}: {
  open: boolean
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const boxRef = useRef<HTMLDivElement>(null)

  // 弹窗打开就把光标放进第一个输入控件：否则焦点停在 body，用户直接打字毫无反应
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      boxRef.current?.querySelector<HTMLElement>('input, textarea, select')?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open])

  if (!open) return null
  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" ref={boxRef} style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button type="button" className="modal-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  hint,
  action
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-mark">◇</div>
      <h4>{title}</h4>
      {hint && <p className="muted">{hint}</p>}
      {action}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
}) {
  return (
    <div className="segmented">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={opt.value === value ? 'active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function TestLine({
  result,
  detail
}: {
  result?: { ok: boolean; latencyMs: number; error?: string } | 'pending'
  detail?: string
}) {
  if (result === 'pending') return <p className="test-line pending">测试中…</p>
  if (!result) return null
  return (
    <p className={`test-line ${result.ok ? 'ok' : 'bad'}`} title={detail}>
      {result.ok ? '✓' : '✕'} {result.ok ? `${result.latencyMs} ms` : result.error}
      {result.ok && detail ? ` · ${detail}` : ''}
    </p>
  )
}

export function Chip({
  children,
  tone = 'neutral',
  onRemove
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'warn'
  onRemove?: () => void
}) {
  return (
    <span className={`chip chip-${tone}`}>
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} title="移除">
          ✕
        </button>
      )}
    </span>
  )
}
