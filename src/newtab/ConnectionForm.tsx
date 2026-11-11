import { useState, type FormEvent } from 'react'
import { ArrowRight, Cloud, LoaderCircle } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { normalizeConnection } from '../core/webdav'
import { rpc, type Snapshot } from '../core/protocol'
import { Button } from './ui'
import QuarkConnectionForm from './QuarkConnectionForm'
import { feedbackStyles, formStyles } from './form-styles'

const providerOptions = tv({
  base: 'flex gap-[8px] mb-[20px]',
  variants: { connected: { true: 'mt-[20px]', false: 'mt-0' } },
})

type Props = { initial?: Snapshot['connection']; connected: boolean; done: (state: Snapshot) => void; onError: (message: string) => void }
export default function ConnectionForm(props: Props) {
  const [provider, setProvider] = useState<'quark' | 'webdav'>(props.initial?.kind === 'webdav' ? 'webdav' : 'quark')
  return <div><div className={providerOptions({ connected: props.connected })} role="group" aria-label="存储方式"><Button tone={provider === 'quark' ? 'primary' : 'ghost'} onClick={() => setProvider('quark')}>夸克网盘</Button><Button tone={provider === 'webdav' ? 'primary' : 'ghost'} onClick={() => setProvider('webdav')}>WebDAV</Button></div>{provider === 'quark' ? <QuarkConnectionForm {...props} /> : <WebDAVConnectionForm {...props} />}</div>
}
function WebDAVConnectionForm({ initial, connected, done, onError }: Props) {
  const [nickname, setNickname] = useState('')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [username, setUsername] = useState(initial?.username ?? '')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'switch' | 'migrate'>('switch')
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const styles = formStyles({ onboarding: !connected })
  async function submit(event?: FormEvent, confirmed = false) {
    event?.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const config = normalizeConnection({ url, username, password })
      const origin = `${new URL(config.url).origin}/*`
      // Keep this call in the click/submit gesture, before any asynchronous work.
      const allowed = await chrome.permissions.request({ origins: [origin] })
      if (!allowed) throw new Error('需要授权访问此 WebDAV 服务器才能连接')
      const response = await rpc({ type: 'connect', config, nickname, mode, confirmed })
      if (response.confirmation) { setConfirmation(response.confirmation); return }
      if (response.snapshot) done(response.snapshot)
    } catch (error) { onError(error instanceof Error ? error.message : '连接失败，请重试') }
    finally { setBusy(false) }
  }
  return <form className={connected ? 'mt-[25px]' : undefined} onSubmit={submit}>
    {!connected && <label className={styles.label()}>昵称<input className={styles.control()} aria-label="昵称" placeholder="怎么称呼你？" value={nickname} onChange={e => setNickname(e.target.value)} required maxLength={80} autoComplete="nickname" /></label>}
    <label className={styles.label()}>WebDAV 地址<input className={styles.control()} aria-label="WebDAV 地址" type="url" placeholder="https://dav.example.com/your-folder/" value={url} onChange={e => { setUrl(e.target.value); setConfirmation('') }} required autoComplete="url" /></label>
    <div className={styles.row()}><label className={styles.rowLabel()}>用户名<input className={styles.control()} aria-label="用户名" value={username} onChange={e => { setUsername(e.target.value); setConfirmation('') }} placeholder="你的 WebDAV 用户名" required autoComplete="username" /></label><label className={styles.rowLabel()}>密码或应用专用密码<input className={styles.control()} aria-label="密码或应用专用密码" type="password" value={password} onChange={e => { setPassword(e.target.value); setConfirmation('') }} placeholder="仅保存在这台设备" required autoComplete="current-password" /></label></div>
    {connected && <fieldset className={styles.fieldset({ className: 'mt-0 mx-0 mb-[16px]' })}><legend className={styles.legend()}>更换数据源时</legend><label className={styles.radioLabel()}><input className={styles.radio()} type="radio" checked={mode === 'switch'} onChange={() => { setMode('switch'); setConfirmation('') }} />切换到另一份数据<span className={styles.radioHint()}>保留各自的本地内容</span></label><label className={styles.radioLabel()}><input className={styles.radio()} type="radio" checked={mode === 'migrate'} onChange={() => { setMode('migrate'); setConfirmation('') }} />迁移当前数据<span className={styles.radioHint()}>先读取目标，再确认合并</span></label></fieldset>}
    {confirmation ? <div className={feedbackStyles.confirmation()}><p className={feedbackStyles.confirmationText()}>{confirmation}</p><Button tone="primary" disabled={busy} onClick={() => void submit(undefined, true)}>确认合并</Button><Button onClick={() => setConfirmation('')}>取消</Button></div> : <Button tone="primary" size="custom" className="w-full mt-[5px] p-[13px] text-[12px]" type="submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="animate-spin" /> : <Cloud size={17} />}{busy ? '正在连接…' : connected ? '连接数据源' : '连接并开始'}{!busy && <ArrowRight size={17} />}</Button>}
  </form>
}
