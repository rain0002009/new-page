import { documentStyles } from './document-styles'
import { useEffect, useState } from 'react'
import { Download, FileText } from 'lucide-react'
import { documentUrl, downloadMarkdown, isMarkdownUrl } from '../core/markdown'
import { rpc } from '../core/protocol'
import { Button } from '../newtab/ui'
import FluidBackground from '../newtab/FluidBackground'
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
    try { const result = await rpc({ type: 'read-markdown', url: address }); setFile(result.file) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '读取失败，请重试') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [address])
  const title = (() => { try { return decodeURIComponent(new URL(file?.url ?? address).pathname.split('/').pop() || 'Markdown') } catch { return 'Markdown' } })()
  return <><FluidBackground /><main className={documentStyles.main()}>
    <header className={documentStyles.header()}><span className="flex items-center gap-[8px]"><FileText size={20} />Markdown 阅读</span><div className={documentStyles.actions()}><Button onClick={() => { void chrome.tabs.create({ url: chrome.runtime.getURL('document/index.html') }) }}>打开本地文件 / 文件夹</Button><Button onClick={() => void load()} disabled={loading}>重新加载</Button><Button disabled={!file} aria-label="导出 Markdown" onClick={() => file && downloadMarkdown(title, file.body)}><Download size={16} />导出</Button></div></header>
    <p role="status" className={documentStyles.status()}>{loading ? '正在读取…' : '在线文件 · 只读阅读'}</p>
    {error && <div role="alert" className={documentStyles.error()}>{error}<Button disabled={loading} onClick={() => void load()}>重试</Button><Button onClick={() => { void rpc({ type: 'open-original', url: address }).catch(cause => setError(cause.message)) }}>打开原网页</Button></div>}
    {file && <div className={documentStyles.columns()}><aside className={documentStyles.sidebar()}><div className={documentStyles.modes()}><Button aria-pressed>大纲</Button><Button aria-label="文件目录" disabled title="在线文件不提供本地文件目录">目录</Button></div><DocumentOutline body={file.body} /></aside><section className={documentStyles.surface()} onClickCapture={event => {
      const anchor = (event.target as Element).closest('a')
      if (anchor && isMarkdownUrl(anchor.href)) { event.preventDefault(); event.stopPropagation(); location.href = documentUrl({ url: anchor.href }) }
    }}>
      <input aria-label="文件名称" value={title} readOnly className={documentStyles.title()} />
      <MarkdownEditor key={file.url} value={file.body} readonly onChange={() => {}} onError={setError} resource={async url => new URL(url, file.url).href} />
    </section></div>}
  </main></>
}
