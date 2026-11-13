import { noteDocumentStyles } from './document-styles'
import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { readLocalSnapshot, type StoredWorkspace } from '../core/local-workspace'
import { documentUrl, downloadMarkdown, isMarkdownUrl } from '../core/markdown'
import { isActive } from '../core/model'
import { rpc } from '../core/protocol'
import { Button } from '../newtab/ui'
import MarkdownEditor from './MarkdownEditor'
import DocumentOutline from './DocumentOutline'

export default function DocumentApp() {
  const params = new URLSearchParams(location.search)
  const id = params.get('note') ?? '', sourceId = params.get('source') ?? ''
  const token = useRef(crypto.randomUUID()).current
  const [owner, setOwner] = useState(false)
  const editable = useRef(false)
  const handingOff = useRef(false)
  const [draft, setDraft] = useState<{ title: string; body: string }>()
  const latest = useRef(draft)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('正在加载…')
  const [available, setAvailable] = useState(true)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const pending = useRef(Promise.resolve())
  useEffect(() => {
    let disposed = false
    async function refresh() {
      try {
        const data = await readLocalSnapshot()
        const stored = await chrome.storage.local.get('new-page.workspace.v1')
        if (disposed) return
        const registered = (stored['new-page.workspace.v1'] as StoredWorkspace | undefined)?.editors?.[`${sourceId}:${id}`]?.token === token
        if (!registered) handingOff.current = false
        const owns = registered && !handingOff.current
        editable.current = owns; setOwner(owns)
        if (data.sourceId !== sourceId) throw new Error('收藏库已切换，请返回当前收藏库打开笔记；当前内容已保留')
        const entity = data.document?.entities[id]
        if (entity?.kind !== 'note' || !isActive(data.document!, entity)) throw new Error(entity?.purged ? '笔记已永久删除' : '笔记已删除或移入回收站')
        setAvailable(true)
        setError('')
        if (!dirty.current) { const next = { title: entity.title, body: entity.body }; latest.current = next; setDraft(next); setStatus('已保存到本机') }
      } catch (cause) { if (!disposed) { editable.current = false; setAvailable(false); setError(cause instanceof Error ? cause.message : '读取失败，请重试') } }
    }
    void rpc({ type: 'note-editor', sourceId, id, token }).then(refresh).catch(cause => setError(cause.message))
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && changes['new-page.workspace.v1']) void refresh() }
    chrome.storage.onChanged.addListener(changed)
    const flush = (message: { type: string; sourceId?: string; id?: string; token?: string }, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => {
      if (sender.id !== chrome.runtime.id || message.type !== 'note-flush' || message.sourceId !== sourceId || message.id !== id || message.token !== token) return false
      handingOff.current = true; editable.current = false; setOwner(false)
      void save().then(() => { if (dirty.current) { handingOff.current = false; editable.current = true; setOwner(true) } respond({ saved: !dirty.current }) })
      return true
    }
    chrome.runtime.onMessage.addListener(flush)
    return () => { disposed = true; chrome.storage.onChanged.removeListener(changed); chrome.runtime.onMessage.removeListener(flush); clearTimeout(timer.current) }
  }, [id, sourceId])
  function save() {
    const value = latest.current
    if (!value || !dirty.current) return pending.current
    pending.current = pending.current.catch(() => {}).then(async () => {
      try {
        await rpc({ type: 'save-note', sourceId, id, token, ...value })
        if (latest.current === value) { dirty.current = false; setStatus('已保存到本机'); setError('') }
      } catch (cause) { setStatus('尚未保存'); setError(cause instanceof Error ? cause.message : '保存失败，内容已保留') }
    })
    return pending.current
  }
  function change(patch: Partial<{ title: string; body: string }>) {
    if (!available || !editable.current || !latest.current) return
    const next = { ...latest.current, ...patch }; latest.current = next; setDraft(next); dirty.current = true; setStatus('正在保存…')
    clearTimeout(timer.current); timer.current = setTimeout(save, 150)
  }
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => { if (dirty.current) { save(); event.preventDefault() } }
    window.addEventListener('beforeunload', leaving)
    return () => window.removeEventListener('beforeunload', leaving)
  })
  return <main className={noteDocumentStyles.main()}>
    <header className={noteDocumentStyles.header()}><p role="status" className={noteDocumentStyles.status()}>{status}</p><Button disabled={!draft} aria-label="导出 Markdown" onClick={() => draft && downloadMarkdown(draft.title, draft.body)}><Download size={16} />导出</Button></header>
    {error && <div role="alert" className={noteDocumentStyles.error()}>{error}{dirty.current && <Button onClick={save}>重试保存</Button>}</div>}
    {!owner && available && draft && <div className="flex flex-wrap items-center gap-[12px] mb-[16px] text-[12px] text-ui-muted"><span>当前页面只读；可接管编辑权继续书写</span><Button onClick={() => { void rpc({ type: 'note-editor', sourceId, id, token, takeover: true }).catch(cause => setError(cause.message)) }}>在此编辑</Button></div>}
    {draft && <div className={noteDocumentStyles.columns()}><aside className={noteDocumentStyles.sidebar()}><DocumentOutline body={draft.body} /></aside><section className={noteDocumentStyles.surface()} onClickCapture={event => { const anchor = (event.target as Element).closest('a'); if (anchor && isMarkdownUrl(anchor.href)) { event.preventDefault(); event.stopPropagation(); void save().then(() => { if (!dirty.current) void chrome.tabs.create({ url: documentUrl({ url: anchor.href }) }) }) } }}>
      <input aria-label="笔记标题" value={draft.title} maxLength={1000} readOnly={!available || !owner} onChange={event => change({ title: event.target.value })} className={noteDocumentStyles.title()} />
      <MarkdownEditor value={draft.body} readonly={!available || !owner} onChange={body => change({ body })} onError={setError} />
    </section></div>}
  </main>
}
