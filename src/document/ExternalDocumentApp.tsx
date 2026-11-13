import { documentStyles } from './document-styles'
import { useEffect, useState } from 'react'
import { documentUrl, isMarkdownUrl } from '../core/markdown'
import { rpc } from '../core/protocol'
import { Button } from '../newtab/ui'
import MarkdownEditor from './MarkdownEditor'
import DocumentOutline from './DocumentOutline'
import LocalDocumentApp from './LocalDocumentApp'

export default function ExternalDocumentApp() {
  const address = location.search.startsWith('?address=') ? location.href.split('?address=')[1] : new URLSearchParams(location.search).get('url') ?? ''
  return !address || address.startsWith('file:') ? <LocalDocumentApp address={address} /> : <RemoteDocument address={address} />
}
function RemoteDocument({ address }: { address: string }) {
  const [file, setFile] = useState<{ body: string; url: string }>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  async function load() {
    setLoading(true); setError('')
    try {
      const result = await rpc({ type: 'read-markdown', url: address })
      if (result.originalUrl) { await rpc({ type: 'open-original', url: result.originalUrl }); return }
      setFile(result.file)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '读取失败，请重试') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [address])
  const title = (() => { try { return decodeURIComponent(new URL(file?.url ?? address).pathname.split('/').pop() || 'Markdown') } catch { return 'Markdown' } })()
  return <main className={documentStyles.main()}>
    <header className={documentStyles.header()}><Button onClick={() => void load()} disabled={loading}>重新加载</Button></header>
    {loading && <p role="status" className={documentStyles.status()}>正在读取…</p>}
    {error && <div role="alert" className={documentStyles.error()}>{error}<Button disabled={loading} onClick={() => void load()}>重试</Button><Button onClick={() => { void rpc({ type: 'open-original', url: address }).catch(cause => setError(cause.message)) }}>打开原网页</Button></div>}
    {file && <div className={documentStyles.columns()}><aside className={documentStyles.sidebar()}><DocumentOutline body={file.body} /></aside><section className={documentStyles.surface()} onClickCapture={event => {
      const anchor = (event.target as Element).closest('a')
      if (anchor && isMarkdownUrl(anchor.href)) { event.preventDefault(); event.stopPropagation(); location.href = documentUrl({ url: anchor.href }) }
    }}>
      <input aria-label="文件名称" value={title} readOnly className={documentStyles.title()} />
      <MarkdownEditor key={file.url} value={file.body} readonly onChange={() => {}} onError={setError} resource={async url => new URL(url, file.url).href} />
    </section></div>}
  </main>
}
