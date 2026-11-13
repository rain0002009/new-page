import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Cloud, LoaderCircle, RefreshCw, ScanLine } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { rpc, type Snapshot } from '../core/protocol'
import type { QrState, QuarkConnection } from '../core/quark/auth'
import { allowQuarkAccess, loadQuarkQr } from './quark-login'
import { Button } from './ui'
import { feedbackStyles, formStyles } from './form-styles'
import { Toast } from '../shared/Toast'

const qrStyles = tv({
  slots: {
    base: 'p-[20px] text-center bg-form-surface border border-solid border-ui-line rounded-[12px] my-[18px]',
    code: 'block max-w-full h-auto m-auto rounded-[9px] bg-white',
    status: 'flex gap-[7px] items-center justify-center text-[11px] mt-[15px] mb-[7px] text-[#788b67]',
    hint: 'text-[9px] text-[#9da88e]',
  },
})()
const fields = formStyles()

export default function QuarkConnectionForm({ connected, initial, done, onError }: { connected: boolean; initial?: Snapshot['connection']; done: (data: Snapshot) => void; onError: (message: string) => void }) {
  const [qr, setQr] = useState<QrState | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<'permission' | 'qr' | null>(null)
  const [nickname, setNickname] = useState('')
  const [mode, setMode] = useState<'switch' | 'migrate'>(initial?.kind === 'webdav' ? 'migrate' : 'switch')
  const [pending, setPending] = useState<{ config: QuarkConnection; message: string } | null>(null)
  const [error, setError] = useState('')
  const [authenticated, setAuthenticated] = useState<QuarkConnection | null>(null)
  const latest = useRef({ done, onError, nickname, mode })
  latest.current = { done, onError, nickname, mode }
  async function connect(config: QuarkConnection, confirmed = false) {
    const state = latest.current
    const result = await rpc({ type: 'connect', config, nickname: state.nickname, mode: state.mode, confirmed })
    if (result.confirmation) setPending({ config, message: result.confirmation })
    else if (result.snapshot) { setQr(null); setAuthenticated(null); setPending(null); setError(''); state.done(result.snapshot) }
  }
  async function start() {
    setBusy(true); setStage('permission'); setError(''); setPending(null); setAuthenticated(null)
    try {
      await allowQuarkAccess()
      setStage('qr')
      const result = await loadQuarkQr()
      if (!result.qr) throw new Error('二维码获取失败，请重试')
      setQr(result.qr)
    } catch (error) { setError(error instanceof Error ? error.message : '获取二维码失败') }
    finally { setBusy(false); setStage(null) }
  }
  useEffect(() => {
    if (!qr || qr.status !== 'pending') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        if (Date.now() >= new Date(qr.expiresAt).getTime()) { setQr({ ...qr, status: 'expired' }); return }
        const result = await rpc({ type: 'quark-qr-poll', id: qr.id })
        if (stopped) return
        if (result.qr?.status === 'confirmed' && result.config) {
          setQr(result.qr)
          setAuthenticated(result.config)
          await connect(result.config).catch(error => setError(error instanceof Error ? error.message : '读取收藏失败，请重试'))
          return
        }
        if (result.qr?.status === 'expired') { setQr(result.qr); return }
        setError('')
      } catch (error) {
        if (stopped) return
        setError(error instanceof Error ? error.message : '查询登录状态失败')
      }
      if (!stopped) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1200)
    return () => { stopped = true; clearTimeout(timer) }
  }, [qr?.id, qr?.status])
  return <div className="mt-[20px]">
    {!connected && <label className={fields.label()}>昵称<input className={fields.control()} aria-label="昵称" value={nickname} onChange={e => setNickname(e.target.value)} maxLength={80} placeholder="可选，默认使用夸克昵称" autoComplete="nickname" /></label>}
    {initial?.kind === 'quark' && <p className={feedbackStyles.muted()}>当前夸克账号：{initial.username}</p>}
    {connected && <fieldset className={fields.fieldset({ className: 'my-[16px] mx-0' })}><legend className={fields.legend()}>登录后的数据</legend><label className={fields.radioLabel()}><input className={fields.radio()} type="radio" checked={mode === 'switch'} onChange={() => setMode('switch')} />使用该账号的收藏</label><label className={fields.radioLabel()}><input className={fields.radio()} type="radio" checked={mode === 'migrate'} onChange={() => setMode('migrate')} />把当前收藏迁移到该账号</label></fieldset>}
    {qr?.status === 'pending' && <div className={qrStyles.base()} aria-label="夸克登录二维码"><QRCodeSVG className={qrStyles.code()} value={qr.url} size={184} level="M" marginSize={3} title="使用夸克 App 扫码登录" /><p className={qrStyles.status()} role="status"><ScanLine size={15} />使用夸克 App 扫码并确认登录</p><small className={qrStyles.hint()}>二维码有效期约 5 分钟</small></div>}
    <Toast message={qr?.status === 'expired' ? '二维码已过期，请刷新后重新扫描。' : ''} tone="info" />
    {qr?.status === 'confirmed' && !pending && !error && <p role="status" className={feedbackStyles.muted()}>扫码已完成，正在读取收藏。</p>}
    <Toast message={error} onClose={() => setError('')}>{authenticated && <Button disabled={busy} onClick={() => {
      setBusy(true)
      void connect(authenticated).catch(error => setError(error instanceof Error ? error.message : '读取收藏失败')).finally(() => setBusy(false))
    }}>重新读取收藏</Button>}</Toast>
    {pending ? <div className={feedbackStyles.confirmation()}><p className={feedbackStyles.confirmationText()}>{pending.message}</p><Button tone="primary" disabled={busy} onClick={() => {
      setBusy(true)
      void connect(pending.config, true).catch(error => setError(error instanceof Error ? error.message : '连接失败')).finally(() => setBusy(false))
    }}>确认合并</Button><Button onClick={() => setPending(null)}>取消</Button></div> : <Button tone="primary" className="w-full mt-[16px]" disabled={busy} onClick={() => void start()}>{busy ? <LoaderCircle size={17} className="animate-spin" /> : qr ? <RefreshCw size={17} /> : <Cloud size={17} />}{busy ? stage === 'permission' ? '正在检查 Chrome 授权…' : stage === 'qr' ? '正在获取二维码…' : '正在读取收藏…' : qr ? '刷新二维码' : connected ? '重新扫码 / 切换账号' : '扫码登录夸克'}</Button>}
  </div>
}
