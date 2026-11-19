import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, ListTree } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { Button, Tooltip } from '../newtab/ui'
import DocumentOutline from './DocumentOutline'
import { readLocalDirectory, fileAccessMessage, type LocalDirectoryEntry } from './local-directory'
import { Toast } from '../shared/Toast'

const navigationButton = tv({
  base: 'border-0 rounded-[6px] hover:bg-ui-surface',
  variants: { selected: { true: 'bg-ui-selection text-ui-sage-deep', false: 'bg-transparent text-ui-sage' } },
})

export default function LocalDocumentSidebar({ body, directory, active, browsing, busy, error, browse, outline, open }: {
  body: string; directory?: string; active?: string; browsing: boolean; busy: boolean; error: string
  browse: () => void; outline: () => void; open: (url: string) => Promise<void>
}) {
  return <>
    <div role="group" aria-label="文档导航切换" className="flex items-center gap-[4px] mb-[12px]">
      <Tooltip content="文件目录">
        <Button tone="custom" size="icon" className={navigationButton({ selected: browsing })} aria-label="文件目录" aria-pressed={browsing} disabled={busy} onClick={browse}><Folder size={17} /></Button>
      </Tooltip>
      <Tooltip content="文档大纲">
        <Button tone="custom" size="icon" className={navigationButton({ selected: !browsing })} aria-label="文档大纲" aria-pressed={!browsing} onClick={outline}><ListTree size={17} /></Button>
      </Tooltip>
    </div>
    {busy && <p role="status" className="text-[11px] text-ui-muted">正在读取目录…</p>}
    {error && <DirectoryError error={error} />}
    {browsing && directory ? <nav aria-label="本地目录" className="max-h-[75vh] overflow-auto [@media(max-width:650px)]:max-h-[180px]">
      <p className="m-0 px-[5px] pb-[8px] text-[11px] text-ui-muted [overflow-wrap:anywhere]">{decodeURIComponent(new URL(directory).pathname.split('/').at(-2) ?? '')}</p>
      <DirectoryEntries key={directory} directory={directory} active={active} open={open} />
    </nav> : <DocumentOutline body={body} />}
  </>
}

export function FileAccessSettingsButton() {
  return <Button onClick={() => void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}>打开扩展设置</Button>
}

function DirectoryError({ error, retry }: { error: string; retry?: () => void }) {
  return <Toast message={error}>{error === fileAccessMessage && <FileAccessSettingsButton />}{retry && <Button onClick={retry}>重试</Button>}</Toast>
}

function DirectoryEntries({ directory, active, open }: { directory: string; active?: string; open: (url: string) => Promise<void> }) {
  const [entries, setEntries] = useState<LocalDirectoryEntry[]>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void readLocalDirectory(directory, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
      .then(next => { if (!controller.signal.aborted) setEntries(next) })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法读取文件夹，请重试') })
    return () => controller.abort()
  }, [directory, retry])
  if (error) return <DirectoryError error={error} retry={() => setRetry(value => value + 1)} />
  if (!entries) return <p role="status" className="text-[11px] text-ui-muted">正在读取目录…</p>
  if (!entries.length) return <p className="text-[11px] text-ui-muted px-[5px]">此文件夹没有 Markdown 文件或子目录</p>
  return <ul className="list-none m-0 p-0">{entries.map(entry => <DirectoryEntry key={entry.url} entry={entry} active={active} open={open} />)}</ul>
}

function DirectoryEntry({ entry, active, open }: { entry: LocalDirectoryEntry; active?: string; open: (url: string) => Promise<void> }) {
  const [expanded, setExpanded] = useState(false)
  const { name, url } = entry
  const isDirectory = entry.kind === 'directory'
  const selected = !isDirectory && url === active
  return <li>
    <Button tone="custom" size="custom" className={navigationButton({ selected, className: 'w-full py-[8px] px-[5px] text-left text-[12px]' })} aria-label={isDirectory ? `文件夹 ${name}` : `打开 ${name}`} aria-expanded={isDirectory ? expanded : undefined} aria-current={selected ? 'page' : undefined} onClick={() => { if (isDirectory) setExpanded(value => !value); else void open(url) }}><span className="flex w-full items-center gap-[6px]">
      {isDirectory ? expanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" /> : <span className="w-[12px] shrink-0" />}
      {isDirectory ? <Folder size={14} className="shrink-0" /> : <FileText size={14} className="shrink-0" />}<span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{name}</span></span>
    </Button>
    {isDirectory && expanded && <div className="pl-[12px]"><DirectoryEntries directory={url} active={active} open={open} /></div>}
  </li>
}
