import { documentStyles } from './document-styles'
import { useEffect, useRef, useState } from 'react'
import { documentUrl } from '../core/markdown'
import { rpc } from '../core/protocol'
import { Button } from '../newtab/ui'
import LocalDocumentSidebar, { FileAccessSettingsButton } from './LocalDocumentSidebar'
import MarkdownEditor from './MarkdownEditor'
import { recallFile, rememberFile, markdownName, readFileHandle, relativeFile, type LocalFile, type FileHandle } from './local-files'
import { fileDirectoryUrl, requireFileUrlAccess } from './local-directory'

export default function LocalDocumentApp({ address = '' }: { address?: string }) {
  const [file, setFile] = useState<LocalFile>()
  const current = useRef<LocalFile>()
  const [resourceEpoch, setResourceEpoch] = useState(0)
  const resources = useRef<string[]>([])
  const [error, setError] = useState('')
  const [status, setStatus] = useState(address ? '正在读取…' : '请将 Markdown 文件拖入新标签页')
  const [conflict, setConflict] = useState<{ disk: string; body: string }>()
  const conflictRef = useRef(false)
  const dirty = useRef(false)
  const [loading, setLoading] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [directoryBusy, setDirectoryBusy] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  const [directory, setDirectory] = useState<string>()
  const navigationEpoch = useRef(0)
  const selectionEpoch = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const pending = useRef(Promise.resolve())
  const drafts = useRef(Promise.resolve())
  const recordId = useRef(new URLSearchParams(location.search).get('local') ?? crypto.randomUUID())
  async function show(next: LocalFile) {
    selectionEpoch.current++; setLoading(false)
    current.current = next; setFile(next); dirty.current = !!next.dirty; setError(next.handle && next.writable === false ? '未获得写入权限，当前内容只读；可重新授权后编辑' : ''); setConflict(undefined); conflictRef.current = false
    setResourceEpoch(value => value + 1)
    resources.current.forEach(url => URL.revokeObjectURL(url)); resources.current = []
    setStatus(next.dirty ? '尚未保存 · 已恢复编辑草稿' : next.handle && next.writable !== false ? '已保存到原文件' : '')
    if (next.handle) { await rememberFile(next, recordId.current); history.replaceState(null, '', documentUrl({ local: recordId.current })) }
    else if (next.url) history.replaceState(null, '', documentUrl({ url: next.url }))
  }
  async function readAddress(isDisposed = () => false, url = current.current?.url ?? address) {
    const selection = selectionEpoch.current
    setLoading(true); setError(''); setStatus('正在读取…')
    try {
      await requireFileUrlAccess()
      const result = await rpc({ type: 'read-markdown', url })
      if (!isDisposed() && selection === selectionEpoch.current && result.file) await show({ title: decodeURIComponent(new URL(url).pathname.split('/').pop()!), body: result.file.body, baseline: result.file.body, url })
    } catch (cause) {
      if (!isDisposed() && selection === selectionEpoch.current) { setStatus('读取失败'); setError(cause instanceof Error ? cause.message : '读取失败，请重试') }
    } finally { if (!isDisposed() && selection === selectionEpoch.current) setLoading(false) }
  }
  function unprotectedChanges() { return dirty.current }
  function ensureSelection(selection: number) {
    if (selection !== selectionEpoch.current) throw new Error('当前文件已变化，内容已保留，请重新打开目标文件')
  }
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const local = new URLSearchParams(location.search).get('local')
        if (local) {
          const selection = selectionEpoch.current
          const remembered = await recallFile(local)
          if (disposed || selection !== selectionEpoch.current) return
          await show(remembered)
          try {
            const disk = await remembered.handle?.getFile().then(value => value.text())
            if (disposed || current.current !== remembered) return
            if (disk !== undefined && !remembered.dirty) await show({ ...remembered, body: disk, baseline: disk })
            else if (disk !== undefined && disk !== remembered.baseline) { conflictRef.current = true; setConflict({ disk, body: remembered.body }); setError('磁盘文件已被其他程序修改，编辑草稿已保留，请选择版本') }
            else if (remembered.dirty) void save()
          } catch { if (!disposed && current.current === remembered) setError('文件权限已失效，内容已保留，请重新授权后读取或保存') }
        } else if (address) await readAddress(() => disposed)
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : '读取失败，请重新拖入文件') }
    })()
    return () => { disposed = true; clearTimeout(timer.current); resources.current.forEach(url => URL.revokeObjectURL(url)) }
  }, [address])
  function save() {
    const value = current.current
    if (!value?.handle || value.writable === false || !dirty.current || conflictRef.current) return pending.current
    pending.current = pending.current.catch(() => {}).then(async () => {
      const active = current.current
      if (!active || active.handle !== value.handle || conflictRef.current) return
      try {
        const disk = await (await value.handle!.getFile()).text()
        if (disk !== active.baseline) {
          conflictRef.current = true; setConflict({ disk, body: active.body }); throw new Error('磁盘文件已被其他程序修改，请选择要保留的版本')
        }
        const writer = await value.handle!.createWritable()
        try { await writer.write(value.body); await writer.close() } catch (cause) { await writer.abort().catch(() => {}); throw cause }
        if (current.current) current.current.baseline = value.body
        if (current.current === value) { dirty.current = false; value.dirty = false; setStatus('已保存到原文件'); setError('') }
        await drafts.current
        await rememberFile(current.current!, recordId.current)
      } catch (cause) { setStatus('尚未保存'); setError(`${cause instanceof Error ? cause.message : '写入失败'}；编辑内容已保留，可重新授权或重试`) }
    })
    return pending.current
  }
  function change(body: string) {
    if (!current.current?.handle || current.current.writable === false) return
    selectionEpoch.current++
    const next = { ...current.current, body, dirty: true }; current.current = next; setFile(next); dirty.current = true
    drafts.current = drafts.current.catch(() => {}).then(async () => { await rememberFile(next, recordId.current) }).catch(() => setError('编辑草稿暂时无法保存，请保持页面打开并重试保存'))
    setStatus('正在保存…')
    clearTimeout(timer.current); timer.current = setTimeout(save, 200)
  }
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => { if (unprotectedChanges()) { void save(); event.preventDefault() } }
    window.addEventListener('beforeunload', leaving)
    return () => window.removeEventListener('beforeunload', leaving)
  })
  async function authorize() {
    const value = current.current
    if (!value?.handle) return
    try {
      const selection = selectionEpoch.current
      if (value.handle.requestPermission && await value.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('未获得写入权限')
      ensureSelection(selection)
      const next = { ...value, writable: true }; current.current = next; setFile(next); setError('')
      if (dirty.current) await save()
      else { await rememberFile(next, recordId.current); setStatus('已保存到原文件') }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '授权失败，请重试') }
  }
  async function openFile(handle: FileHandle, path: string[]) {
    try {
      await save(); if (unprotectedChanges()) throw new Error('当前内容尚未保存，请先保存后再切换文件')
      const selection = selectionEpoch.current
      const next = await readFileHandle(handle, current.current?.directory, path)
      ensureSelection(selection)
      recordId.current = crypto.randomUUID(); await show(next)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '文件打开失败，请重新拖入文件') }
  }
  async function browseDirectory() {
    const value = current.current
    if (!value || directoryBusy) return
    const request = ++navigationEpoch.current
    const selection = selectionEpoch.current
    setDirectoryBusy(true); setDirectoryError('')
    try {
      await requireFileUrlAccess()
      const parent = fileDirectoryUrl(value.url ?? address)
      if (request !== navigationEpoch.current) return
      await save()
      if (unprotectedChanges()) throw new Error('当前内容尚未保存，请先保存后再切换目录')
      ensureSelection(selection)
      if (request !== navigationEpoch.current) return
      setDirectory(parent); setBrowsing(true)
    } catch (cause) {
      if (request === navigationEpoch.current) setDirectoryError(cause instanceof Error ? cause.message : '无法读取文件夹，请重试')
    } finally { setDirectoryBusy(false) }
  }
  async function openAddress(url: string) {
    try {
      await save()
      if (unprotectedChanges()) throw new Error('当前内容尚未保存，请先保存后再切换文件')
      selectionEpoch.current++
      await readAddress(() => false, url)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '文件打开失败，请重试') }
  }
  return <main className={documentStyles.main()}>
    {status && <p role="status" className={documentStyles.status()}>{status}</p>}
    {error && <div role="alert" className={documentStyles.error()}>{error}
      {conflict ? <><p>磁盘版本：{conflict.disk}</p><p>编辑版本：{file?.body}</p><Button onClick={() => { if (!current.current) return; const next = { ...current.current, body: conflict.disk, baseline: conflict.disk, dirty: false }; current.current = next; setFile(next); dirty.current = false; setConflict(undefined); conflictRef.current = false; setError(''); setStatus('已读取磁盘版本'); void rememberFile(next, recordId.current).catch(() => setError('草稿记录更新失败，请重试')) }}>使用磁盘版本</Button><Button onClick={() => { if (!current.current) return; current.current.baseline = conflict.disk; conflictRef.current = false; setConflict(undefined); void save() }}>保留编辑版本</Button></> : <>{!file && address ? <Button disabled={loading} onClick={() => void readAddress()}>重试读取</Button> : dirty.current && <Button onClick={() => void save()}>重试保存</Button>}{file?.handle && <Button onClick={() => void authorize()}>重新授权</Button>}</>}
      {address && <Button onClick={() => { void rpc({ type: 'open-original', url: current.current?.url ?? address }).catch(cause => setError(cause.message)) }}>打开原网页</Button>}
      {error.includes('允许访问文件网址') && <FileAccessSettingsButton />}
    </div>}
    {file && <div className={documentStyles.columns()}><aside className={documentStyles.sidebar()}><LocalDocumentSidebar body={file.body} directory={directory} active={file.url} browsing={browsing} busy={directoryBusy} error={directoryError} browse={() => void browseDirectory()} outline={() => { navigationEpoch.current++; setBrowsing(false); setDirectoryError('') }} open={openAddress} /></aside><section className={documentStyles.surface()} onClickCapture={event => {
      const anchor = (event.target as Element).closest('a')
      if (anchor?.protocol === 'file:' && markdownName(new URL(anchor.href).pathname)) {
        event.preventDefault(); event.stopPropagation(); void openAddress(anchor.href); return
      }
      if (!anchor?.hash.startsWith('#local:')) return
      event.preventDefault(); event.stopPropagation()
      const relative = decodeURIComponent(anchor.hash.slice(7))
      if (!current.current) return
      void relativeFile(current.current, relative).then(async result => {
        if (markdownName(result.handle.name)) await openFile(result.handle, result.path)
        else { const url = URL.createObjectURL(await result.handle.getFile()); resources.current.push(url); window.open(url, '_blank', 'noopener') }
      }).catch(cause => setError(cause.message))
    }}>
      <input aria-label="文件名称" value={file.title} readOnly className={documentStyles.title()} />
      <MarkdownEditor key={`${recordId.current}:${resourceEpoch}`} value={file.body} readonly={!file.handle || file.writable === false} onChange={change} onError={setError} resource={async (url, image) => {
        if (file.url) return new URL(url, file.url).href
        if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('#')) return url
        if (!image) return '#local:' + encodeURIComponent(url)
        const result = await relativeFile(current.current!, url)
        const resource = URL.createObjectURL(await result.handle.getFile()); resources.current.push(resource); return resource
      }} />
    </section></div>}
  </main>
}
