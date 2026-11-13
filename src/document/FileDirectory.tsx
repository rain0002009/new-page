import { useEffect, useState } from 'react'
import { Button } from '../newtab/ui'
import { markdownName, type DirectoryHandle, type FileHandle } from './local-files'

export default function FileDirectory({ directory, open, onError }: { directory: DirectoryHandle; open: (handle: FileHandle, path: string[]) => void; onError: (message: string) => void }) {
  return <nav aria-label="文件目录"><Branch directory={directory} path={[]} open={open} onError={onError} /></nav>
}
function Branch({ directory, path, open, onError }: { directory: DirectoryHandle; path: string[]; open: (handle: FileHandle, path: string[]) => void; onError: (message: string) => void }) {
  const [entries, setEntries] = useState<(FileHandle | DirectoryHandle)[]>([])
  const [expanded, setExpanded] = useState<string[]>([])
  useEffect(() => {
    let active = true
    void (async () => {
      const result: (FileHandle | DirectoryHandle)[] = []
      for await (const [, handle] of directory.entries()) if (handle.kind === 'directory' || markdownName(handle.name)) result.push(handle)
      if (active) setEntries(result.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name)))
    })().catch(() => onError('无法读取文件目录，请重新授权文件夹；当前编辑内容已保留'))
    return () => { active = false }
  }, [directory])
  return <ul className="list-none m-0 pl-[10px]">{entries.map(handle => <li key={handle.name}><Button tone="custom" size="custom" className="block w-full text-left py-[8px] px-[4px] bg-transparent border-0 text-ui-sage text-[12px] [overflow-wrap:anywhere] hover:bg-ui-surface" aria-label={handle.kind === 'directory' ? `${expanded.includes(handle.name) ? '折叠' : '展开'} ${handle.name}` : handle.name} aria-expanded={handle.kind === 'directory' ? expanded.includes(handle.name) : undefined} onClick={() => handle.kind === 'file' ? open(handle as FileHandle, [...path, handle.name]) : setExpanded(values => values.includes(handle.name) ? values.filter(name => name !== handle.name) : [...values, handle.name])}>{handle.kind === 'directory' ? `${expanded.includes(handle.name) ? '▾' : '▸'} ${handle.name}` : handle.name}</Button>{handle.kind === 'directory' && expanded.includes(handle.name) && <Branch directory={handle as DirectoryHandle} path={[...path, handle.name]} open={open} onError={onError} />}</li>)}</ul>
}
