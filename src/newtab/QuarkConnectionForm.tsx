import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Cloud, LoaderCircle, RefreshCw, ScanLine } from 'lucide-react'
import { rpc, type Snapshot } from '../core/protocol'
import type { QrState, QuarkConnection } from '../core/quark/auth'
import { quarkOrigins } from '../core/quark/transport'
import { Button } from './ui'

export default function QuarkConnectionForm({ connected, initial, done, onError }: { connected: boolean; initial?: Snapshot['connection']; done: (data: Snapshot) => void; onError: (message: string) => void }) {
  const [qr, setQr] = useState<QrState | null>(null)
  const [busy, setBusy] = useState(false)
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
    setBusy(true); setError(''); setPending(null); setAuthenticated(null)
    try {
      const allowed = await chrome.permissions.request({ origins: quarkOrigins, permissions: ['webRequest', 'declarativeNetRequestWithHostAccess'] })
      if (!allowed) throw new Error('需要授权访问夸克网盘，才能扫码和自动保存')
      const result = await rpc({ type: 'quark-qr-start' })
      if (!result.qr) throw new Error('二维码获取失败，请重试')
      setQr(result.qr)
    } catch (error) { setError(error instanceof Error ? error.message : '获取二维码失败') }
    finally { setBusy(false) }
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
  return <div className="quark-connection">
    {!connected && <label>昵称<input aria-label="昵称" value={nickname} onChange={e => setNickname(e.target.value)} maxLength={80} placeholder="可选，默认使用夸克昵称" autoComplete="nickname" /></label>}
    {initial?.kind === 'quark' && <p className="muted">当前夸克账号：{initial.username}</p>}
    {connected && <fieldset><legend>登录后的数据</legend><label className="radio-row"><input type="radio" checked={mode === 'switch'} onChange={() => setMode('switch')} />使用该账号的收藏</label><label className="radio-row"><input type="radio" checked={mode === 'migrate'} onChange={() => setMode('migrate')} />把当前收藏迁移到该账号</label></fieldset>}
    {qr?.status === 'pending' && <div className="quark-qr" aria-label="夸克登录二维码"><QRCodeSVG value={qr.url} size={184} level="M" marginSize={3} title="使用夸克 App 扫码登录" /><p role="status"><ScanLine size={15} />使用夸克 App 扫码并确认登录</p><small>二维码有效期约 5 分钟</small></div>}
    {qr?.status === 'expired' && <p role="status" className="muted">二维码已过期，请刷新后重新扫描。</p>}
    {qr?.status === 'confirmed' && !pending && !error && <p role="status" className="muted">扫码已完成，正在读取收藏。</p>}
    {error && <div role="alert" className="alert">{error}</div>}
    {error && authenticated && <Button disabled={busy} onClick={() => {
      setBusy(true)
      void connect(authenticated).catch(error => setError(error instanceof Error ? error.message : '读取收藏失败')).finally(() => setBusy(false))
    }}>重新读取收藏</Button>}
    {pending ? <div className="confirmation"><p>{pending.message}</p><Button tone="primary" disabled={busy} onClick={() => {
      setBusy(true)
      void connect(pending.config, true).catch(error => setError(error instanceof Error ? error.message : '连接失败')).finally(() => setBusy(false))
    }}>确认合并</Button><Button onClick={() => setPending(null)}>取消</Button></div> : <Button tone="primary" disabled={busy} onClick={() => void start()}>{busy ? <LoaderCircle size={17} className="animate-spin" /> : qr ? <RefreshCw size={17} /> : <Cloud size={17} />}{busy ? '正在获取二维码…' : qr ? '刷新二维码' : connected ? '重新扫码 / 切换账号' : '扫码登录夸克'}</Button>}
    <p className="privacy-note">收藏先保存到本机，再自动上传到夸克的「拾页收藏」目录。登录信息只保存在当前设备。</p>
  </div>
}
