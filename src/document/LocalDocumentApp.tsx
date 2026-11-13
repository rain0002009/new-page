import { useEffect, useRef, useState } from 'react'
import { documentUrl, downloadMarkdown } from '../core/markdown'
import { rpc } from '../core/protocol'
import { Button } from '../newtab/ui'
import FluidBackground from '../newtab/FluidBackground'
import DocumentOutline from './DocumentOutline'
import MarkdownEditor from './MarkdownEditor'
import { pickers, selectFile, recallFile, rememberFile, markdownName, readFileHandle, relativeFile, type LocalFile, type DirectoryHandle, type FileHandle } from './local-files'
import FileDirectory from './FileDirectory'

export default function LocalDocumentApp({ address = '' }: { address?: string }) {
  const [file, setFile] = useState<LocalFile>()
  const current = useRef<LocalFile>()
  const [reading, setReading] = useState(true)
  const [directory, setDirectory] = useState<DirectoryHandle>()
  const [tree, setTree] = useState(false)
  const [resourceEpoch, setResourceEpoch] = useState(0)
  const resources = useRef<string[]>([])
  const [error, setError] = useState('')
  const [status, setStatus] = useState(address ? '正在读取…' : '选择本地 Markdown 文件')
  const [conflict, setConflict] = useState<{ disk: string; body: string }>()
  const conflictRef = useRef(false)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const pending = useRef(Promise.resolve())
  const drafts = useRef(Promise.resolve())
  const recordId = useRef(new URLSearchParams(location.search).get('local') ?? crypto.randomUUID())
  const input = useRef<HTMLInputElement>(null)
  async function show(next: LocalFile, editing: boolean) {
    current.current = next; setFile(next); dirty.current = !!next.dirty; setReading(!editing); setError(''); setConflict(undefined); conflictRef.current = false
    setDirectory(next.directory)
    setResourceEpoch(value => value + 1)
    resources.current.forEach(url => URL.revokeObjectURL(url)); resources.current = []
    setStatus(next.dirty ? '尚未保存 · 已恢复编辑草稿' : next.handle ? '已保存到原文件' : '本地文件 · 预览')
    if (next.handle) { await rememberFile(next, recordId.current); history.replaceState(null, '', documentUrl({ local: recordId.current })) }
  }
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const local = new URLSearchParams(location.search).get('local')
        if (local) {
          const remembered = await recallFile(local)
          if (disposed) return
          await show(remembered, false)
          try {
            const disk = await remembered.handle?.getFile().then(value => value.text())
            if (disposed) return
            if (disk !== undefined && !remembered.dirty) await show({ ...remembered, body: disk, baseline: disk }, false)
            else if (disk !== undefined && disk !== remembered.baseline) { conflictRef.current = true; setConflict({ disk, body: remembered.body }); setError('磁盘文件已被其他程序修改，编辑草稿已保留，请选择版本') }
          } catch { setError('文件权限已失效，内容已保留，请重新授权后读取或保存') }
        } else if (address) {
          const result = await rpc({ type: 'read-markdown', url: address })
          if (!disposed && result.file) await show({ title: decodeURIComponent(new URL(address).pathname.split('/').pop()!), body: result.file.body, baseline: result.file.body }, false)
        }
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : '读取失败，请重新选择文件') }
    })()
    return () => { disposed = true; clearTimeout(timer.current); resources.current.forEach(url => URL.revokeObjectURL(url)) }
  }, [address])
  function save() {
    const value = current.current
    if (!value?.handle || !dirty.current || conflictRef.current) return pending.current
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
      } catch (cause) { setStatus('尚未保存'); setError(`${cause instanceof Error ? cause.message : '写入失败'}；编辑内容已保留，可重新授权、重试或导出`) }
    })
    return pending.current
  }
  function change(body: string) {
    if (!current.current || reading) return
    const next = { ...current.current, body, dirty: true }; current.current = next; setFile(next); dirty.current = true
    drafts.current = drafts.current.catch(() => {}).then(async () => { await rememberFile(next, recordId.current) }).catch(() => setError('编辑草稿暂时无法保存，请保持页面打开并导出正文'))
    setStatus(next.handle ? '正在保存…' : '编辑内容待下载另存')
    clearTimeout(timer.current); timer.current = setTimeout(save, 200)
  }
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => { if (dirty.current) { void save(); event.preventDefault() } }
    window.addEventListener('beforeunload', leaving)
    return () => window.removeEventListener('beforeunload', leaving)
  })
  async function choose(expectedName?: string) {
    if (dirty.current) { await save(); if (dirty.current) { setError('当前内容尚未保存，请先保存或导出后再打开其他文件'); return } }
    if (!pickers.showOpenFilePicker) { input.current?.click(); return }
    try {
      const selected = await selectFile()
      if (expectedName && selected.title !== expectedName) throw new Error('所选文件名与当前本地地址不同，请选择当前文件')
      recordId.current = crypto.randomUUID(); await show(selected, true)
    } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : '文件打开失败') }
  }
  async function toggleEditing() {
    if (!file) return
    if (!reading) { setReading(true); return }
    if (!file.handle && pickers.showOpenFilePicker) { await choose(file.title); return }
    try {
      if (file.handle?.requestPermission && await file.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('未获得写入权限，内容已保留，请重新授权')
      setReading(false)
      if (dirty.current) void save()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法获得文件写入权限') }
  }
  async function folder() {
    if (!pickers.showDirectoryPicker) return
    try {
      const selected = await pickers.showDirectoryPicker({ mode: 'readwrite' })
      if (dirty.current) { await save(); if (dirty.current) throw new Error('当前内容尚未保存，请先保存或导出') }
      if (current.current?.handle) {
        const path = await selected.resolve(current.current.handle)
        if (!path) throw new Error('请选择包含当前 Markdown 文件的文件夹')
        const next = { ...current.current, directory: selected, path }; current.current = next; setFile(next); await rememberFile(next, recordId.current)
      } else if (current.current) {
        const handle = await selected.getFileHandle(current.current.title) as FileHandle
        const selectedFile = await readFileHandle(handle, selected, [handle.name])
        if (selectedFile.body !== current.current.body) throw new Error('所选文件夹中的同名文件与当前预览内容不同，请从目录选择目标文件')
        await show(selectedFile, false)
      }
      setDirectory(selected); setResourceEpoch(value => value + 1); setTree(true); setError('')
    } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : '文件夹授权失败') }
  }
  async function openFile(handle: FileHandle, path: string[]) {
    try {
      await save(); if (dirty.current) throw new Error('当前内容尚未保存，请先保存或导出后再切换文件')
      const next = await readFileHandle(handle, directory, path)
      recordId.current = crypto.randomUUID(); await show(next, true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '文件打开失败，请重新授权文件夹') }
  }
  return <><FluidBackground /><main className="relative z-1 mx-auto max-w-[1160px] min-h-screen px-[28px] py-[36px] [@media(max-width:650px)]:px-[16px]">
    <header className="flex flex-wrap items-center justify-between gap-[12px] mb-[24px] text-ui-sage"><span>本地 Markdown</span><div className="flex flex-wrap gap-[8px]">
      <Button onClick={() => void choose()}>打开本地文件</Button>
      <Button disabled={!pickers.showDirectoryPicker} onClick={() => void folder()}>打开文件夹</Button>
      {file && <Button onClick={() => void toggleEditing()}>{reading ? pickers.showOpenFilePicker ? '编辑原文件' : '编辑后下载另存' : '阅读模式'}</Button>}
      <Button disabled={!file} aria-label="导出 Markdown" onClick={() => file && downloadMarkdown(file.title, file.body)}>导出</Button>
    </div></header>
    <input ref={input} type="file" accept=".md,.markdown,text/markdown" className="hidden" aria-label="本地 Markdown 文件" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; if (selected) void (async () => { if (!markdownName(selected.name)) throw new Error('请选择 Markdown 文件'); const body = await selected.text(); await show({ title: selected.name, body, baseline: body }, true) })().catch(cause => setError(cause.message)) }} />
    <p role="status" className="text-[11px] text-ui-muted mb-[12px]">{status}</p>
    {!pickers.showOpenFilePicker && <p className="text-[12px] text-ui-muted">此浏览器支持编辑后下载另存，不支持原文件自动写回或文件目录。</p>}
    {error && <div role="alert" className="rounded-[12px] bg-action-danger-surface p-[16px] mb-[16px] text-action-danger [overflow-wrap:anywhere]">{error}
      {conflict ? <><p>磁盘版本：{conflict.disk}</p><p>编辑版本：{file?.body}</p><Button onClick={() => { if (!current.current) return; const next = { ...current.current, body: conflict.disk, baseline: conflict.disk, dirty: false }; current.current = next; setFile(next); dirty.current = false; setConflict(undefined); conflictRef.current = false; setError(''); setStatus('已读取磁盘版本'); void rememberFile(next, recordId.current).catch(() => setError('草稿记录更新失败，请重试')) }}>使用磁盘版本</Button><Button onClick={() => { if (!current.current) return; current.current.baseline = conflict.disk; conflictRef.current = false; setConflict(undefined); void save() }}>保留编辑版本</Button></> : <><Button onClick={() => void save()}>重试保存</Button>{file?.handle && <Button onClick={() => { void file.handle?.requestPermission?.({ mode: 'readwrite' }).then(permission => { if (permission !== 'granted') throw new Error('未获得写入权限'); return save() }).catch(cause => setError(cause.message)) }}>重新授权</Button>}</>}
      {address && <Button onClick={() => { void rpc({ type: 'open-original', url: address }).catch(cause => setError(cause.message)) }}>打开原网页</Button>}
    </div>}
    {(file || directory) && <div className="grid grid-cols-[190px_minmax(0,1fr)] gap-[24px] [@media(max-width:650px)]:grid-cols-1"><aside className="min-w-0"><div className="flex gap-[8px] mb-[12px]"><Button aria-pressed={!tree} onClick={() => setTree(false)}>大纲</Button><Button aria-label="文件目录" aria-pressed={tree} disabled={!pickers.showDirectoryPicker} onClick={() => { if (!directory) { setError('文件目录需要单独授权，请点击打开文件夹选择当前文件所在文件夹'); return } setTree(true) }}>目录</Button></div>{tree && directory ? <FileDirectory key={directory.name} directory={directory} open={(handle, path) => void openFile(handle, path)} onError={setError} /> : <DocumentOutline body={file?.body ?? ''} />}</aside>{file && <section className="min-w-0 rounded-[22px] bg-ui-surface border border-solid border-white p-[32px] [@media(max-width:650px)]:p-[16px]" onClickCapture={event => {
      const anchor = (event.target as Element).closest('a')
      if (!anchor?.hash.startsWith('#local:')) return
      event.preventDefault(); event.stopPropagation()
      const relative = decodeURIComponent(anchor.hash.slice(7))
      if (!current.current) return
      void relativeFile(current.current, relative).then(async result => {
        if (markdownName(result.handle.name)) await openFile(result.handle, result.path)
        else { const url = URL.createObjectURL(await result.handle.getFile()); resources.current.push(url); window.open(url, '_blank', 'noopener') }
      }).catch(cause => setError(cause.message))
    }}>
      <input aria-label="文件名称" value={file.title} readOnly className="block w-full text-[32px] font-semibold border-0 bg-transparent p-[8px] mb-[20px] focus:outline-none" />
      <MarkdownEditor key={`${recordId.current}:${resourceEpoch}`} value={file.body} readonly={reading} onChange={change} onError={setError} resource={async (url, image) => {
        if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('#')) return url
        if (!image) return '#local:' + encodeURIComponent(url)
        const result = await relativeFile(current.current!, url)
        const resource = URL.createObjectURL(await result.handle.getFile()); resources.current.push(resource); return resource
      }} />
    </section>}</div>}
  </main></>
}
