import { useId, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from './ui'
import { feedbackStyles, formStyles } from './form-styles'

const fields = formStyles()

export default function SeeSettings({ value, onSave }: { value: string; onSave: (value: string) => Promise<boolean> }) {
  const inputId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const key = draft ?? value
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function save(value: string) {
    setBusy(true); setError(''); setMessage('')
    try {
      if (!await onSave(value.trim())) throw new Error('保存失败')
      setDraft(null); setVisible(false)
      setMessage(value.trim() ? 's.ee API Key 已保存' : 's.ee API Key 已清除')
    } catch { setError('保存 s.ee 配置失败，请重试') }
    finally { setBusy(false) }
  }
  return <>
    <div className={fields.label()}><label htmlFor={inputId}>s.ee API Key</label>
      <div className="flex items-center gap-[8px]">
        <input id={inputId} className={fields.control()} aria-label="s.ee API Key" type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} disabled={busy} value={key} onChange={event => { setDraft(event.target.value); setMessage(''); setError('') }} />
        <Button size="icon" disabled={busy} aria-label={visible ? '隐藏 s.ee API Key' : '显示 s.ee API Key'} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</Button>
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-[8px]">
      <Button tone="primary" disabled={busy} aria-label="保存 s.ee API Key" onClick={() => void save(key)}>保存</Button>
      <Button disabled={busy} aria-label="清除 s.ee API Key" onClick={() => void save('')}>清除</Button>
      {message && <span role="status" className="text-[11px] text-ui-muted">{message}</span>}
    </div>
    {error && <p role="alert" className={feedbackStyles.error()}>{error}</p>}
  </>
}
