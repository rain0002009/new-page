import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Filter, MoreHorizontal, Pencil, Search, Tag, Trash2, X } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import {
  active,
  type Action,
  type Document,
  type TagColor,
  type TaggedEntity,
  type Tag as TagRecord,
} from '../core/model'
import { Button, Modal } from './ui'

export type TagAct = (action: Action) => Promise<boolean>
type TagColorChoice = TagColor | 'transparent'

export const tagColorOptions: { value: TagColorChoice; label: string; swatch: string }[] = [
  { value: 'grey', label: '灰色', swatch: 'bg-[#89929e]' },
  { value: 'blue', label: '蓝色', swatch: 'bg-[#598beb]' },
  { value: 'red', label: '红色', swatch: 'bg-[#df6d67]' },
  { value: 'yellow', label: '黄色', swatch: 'bg-[#d6ad39]' },
  { value: 'green', label: '绿色', swatch: 'bg-[#5fa875]' },
  { value: 'pink', label: '粉色', swatch: 'bg-[#d780b5]' },
  { value: 'purple', label: '紫色', swatch: 'bg-[#a081d5]' },
  { value: 'cyan', label: '青色', swatch: 'bg-[#56a6b4]' },
  { value: 'orange', label: '橙色', swatch: 'bg-[#d79351]' },
  { value: 'transparent', label: '透明', swatch: 'bg-[repeating-conic-gradient(#eef1eb_0_25%,#c8d0c5_0_50%)] bg-[length:8px_8px] border border-solid border-[#879580]' },
]

const tagChip = tv({
  base: 'inline-flex max-w-[120px] min-w-0 items-center gap-[4px] rounded-[5px] border border-solid px-[6px] py-[2px] text-[9px] font-medium leading-[14px] truncate align-middle',
  variants: { color: {
    grey: 'bg-[#e7e9e8] border-[#c5cbd0] text-[#53606b]',
    blue: 'bg-[#e4edff] border-[#b8cdf8] text-[#366bc8]',
    red: 'bg-[#fde8e6] border-[#f2bbb6] text-[#b64b45]',
    yellow: 'bg-[#fff5ce] border-[#ead58d] text-[#8b6b18]',
    green: 'bg-[#e3f2e7] border-[#b8d8bf] text-[#3f8553]',
    pink: 'bg-[#fbe7f3] border-[#edbed9] text-[#ac5c8d]',
    purple: 'bg-[#eee7fb] border-[#cfbcec] text-[#7e59b6]',
    cyan: 'bg-[#e1f2f4] border-[#b5dce2] text-[#347e8b]',
    orange: 'bg-[#fff0df] border-[#efcba4] text-[#a86b2e]',
  } },
})

const panel = tv({
  slots: {
    card: 'w-[286px] rounded-[12px] border border-solid border-[#d7e2cc] bg-[#fffffdec] p-[12px] shadow-[0_18px_50px_#334c2b2b]',
    label: 'block text-[10px] font-semibold text-form-label mb-[6px]',
    input: 'w-full rounded-[8px] border border-solid border-form-line bg-form-surface px-[10px] py-[8px] text-[11px] text-form-ink outline-none focus:border-form-focus focus:shadow-[0_0_0_3px_#eaf0df]',
    colors: 'flex flex-wrap gap-[4px] mt-[10px]',
    color: 'h-[20px] w-[20px] rounded-[6px] border border-solid border-transparent p-0',
    list: 'mt-[10px] max-h-[220px] overflow-y-auto space-y-[6px]',
    row: 'grid grid-cols-[18px_minmax(0,1fr)_28px] items-center gap-[6px] rounded-[8px] px-[8px] py-[4px] min-h-[36px] text-[11px] hover:bg-[#f2f5ed]',
    empty: 'px-[8px] py-[12px] text-[10px] text-ui-muted',
    hint: 'mt-[8px] text-[9px] text-ui-muted leading-[1.5]',
    filterButton: 'flex items-center gap-[6px] rounded-[8px] border border-solid border-[#d7e2cc] bg-[#fffffbc4] px-[9px] py-[7px] text-[10px] text-[#61744f] hover:border-[#aabd92] hover:bg-[#f4f8ee]',
  },
  variants: { embedded: {
    true: { card: 'border-0 bg-transparent p-0 shadow-none' },
    false: { card: '' },
  } },
  defaultVariants: { embedded: false },
})

const actionTrigger = tv({
  base: 'shrink-0 rounded-[9px] border border-solid border-transparent text-action-ghost hover:text-action-ghost-hover',
  variants: { placement: {
    card: 'h-[27px] w-[27px] bg-[#f9fcf3e6] opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(max-width:650px)]:opacity-100',
    collection: 'h-[32px] w-[32px] rounded-[6px] bg-transparent text-[#8c9a7f] hover:bg-action-ghost-surface [@media(max-width:650px)]:w-[20px]',
  } },
  defaultVariants: { placement: 'card' },
})

const styles = panel()

function tagNameLength(value: string) {
  return Array.from(value).length
}

function TagChip({ tag, className = '' }: { tag: TagRecord; className?: string }) {
  return <span className={`${tagChip({ color: tag.color })} ${className}`} title={tag.title}>{tag.title}</span>
}

export function TagList({ tags, label, className = '' }: { tags: TagRecord[]; label: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<number>()

  useLayoutEffect(() => {
    const node = rootRef.current
    if (!node) return
    const measure = () => setOverflowing(node.scrollWidth > node.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [tags])

  if (!tags.length) return null
  return <span
    ref={rootRef}
    className={`group/tags relative inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap align-middle text-[10px] ${className}`}
    aria-label={`${label}标签`}
    tabIndex={0}
    onFocus={() => setOpen(true)}
    onBlur={() => setOpen(false)}
    onMouseEnter={() => { if (closeTimer.current) window.clearTimeout(closeTimer.current); setOpen(true) }}
    onMouseLeave={() => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      closeTimer.current = window.setTimeout(() => setOpen(false), 120)
    }}
  >
    <span className="flex min-w-0 items-center gap-[4px] overflow-hidden">
      {tags.map(tag => <TagChip key={tag.id} tag={tag} />)}
    </span>
    {overflowing && <span className="pointer-events-none absolute right-0 top-0 bottom-0 flex items-center bg-[#f9fcf3e6] px-[3px] text-[11px] text-[#66725f]" aria-hidden="true">...</span>}
    {open && <span role="tooltip" className="absolute left-0 top-[calc(100%+6px)] z-40 block w-[220px] rounded-[10px] border border-solid border-[#d7e2cc] bg-[#fffffdec] p-[8px] shadow-[0_16px_36px_#334c2b22]">
      <span className="mb-[6px] block text-[9px] font-semibold text-form-label">{label}的标签</span>
      <span className="flex flex-wrap gap-[5px]">{tags.map(tag => <TagChip key={tag.id} tag={tag} />)}</span>
    </span>}
  </span>
}

function ColorPicker({ value, onChange, allowTransparent = true }: { value: TagColorChoice; onChange: (value: TagColorChoice) => void; allowTransparent?: boolean }) {
  const options = allowTransparent ? tagColorOptions : tagColorOptions.filter(option => option.value !== 'transparent')
  return <div className={styles.colors()} role="radiogroup" aria-label="标签颜色">
    {options.map(option => <button
      key={option.value}
      type="button"
      role="radio"
      aria-checked={value === option.value}
      aria-label={option.label}
      title={option.label}
      className={`${styles.color()} ${option.swatch} ${value === option.value ? 'outline outline-2 outline-offset-2 outline-[#7c9665]' : ''}`}
      onClick={() => onChange(option.value)}
    />)}
  </div>
}

function activeTags(doc: Document) {
  return active(doc).filter((e): e is TagRecord => e.kind === 'tag')
}

export function TagPicker({
  doc,
  target,
  act,
  className = '',
  embedded = false,
  autoFocus = false,
}: {
  doc: Document
  target: TaggedEntity
  act: TagAct
  className?: string
  embedded?: boolean
  autoFocus?: boolean
}) {
  const currentTarget = (doc.entities[target.id] as TaggedEntity | undefined) ?? target
  const [query, setQuery] = useState('')
  const [color, setColor] = useState<TagColorChoice>('transparent')
  const [activeIndex, setActiveIndex] = useState(0)
  const [editing, setEditing] = useState<TagRecord | null>(null)
  const assigned = currentTarget.tagIds ?? []
  const tags = activeTags(doc)
  const normalizedQuery = query.trim()
  const results = tags.filter(tag =>
    (!normalizedQuery || tag.title.toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase())) &&
    (color === 'transparent' || tag.color === color)
  )
  const createColor: TagColor = color === 'transparent' ? tagColorOptions[0].value as TagColor : color
  const exact = tags.find(tag => tag.title === normalizedQuery && tag.color === createColor)

  useEffect(() => {
    setActiveIndex(0)
  }, [normalizedQuery, color, results.length])

  async function setAssigned(tag: TagRecord) {
    const next = assigned.includes(tag.id) ? assigned.filter(id => id !== tag.id) : [...assigned, tag.id]
    await act({ type: 'set-tags', id: currentTarget.id, tagIds: next })
  }

  async function createTag() {
    if (!normalizedQuery) return
    const existing = tags.find(tag => tag.title === normalizedQuery && tag.color === createColor)
    if (existing) {
      if (!assigned.includes(existing.id)) await act({ type: 'set-tags', id: currentTarget.id, tagIds: [...assigned, existing.id] })
      setQuery('')
      return
    }
    const id = crypto.randomUUID()
    if (await act({ type: 'add-tag', id, name: normalizedQuery, color: createColor }) &&
        await act({ type: 'set-tags', id: currentTarget.id, tagIds: [...assigned, id] })) setQuery('')
  }

  async function submitSearch() {
    const highlighted = results[activeIndex]
    if (highlighted) await setAssigned(highlighted)
    else await createTag()
  }

  function moveActive(delta: number) {
    if (!results.length) return
    setActiveIndex(index => (index + delta + results.length) % results.length)
  }

  return <div className={`${styles.card({ embedded })} ${className}`} role="dialog" aria-label="标签管理">
    <label className={styles.label()} htmlFor={`tag-search-${target.id}`}>搜索或创建标签</label>
    <div className="relative">
      <Search size={13} className="absolute left-[9px] top-[9px] text-[#91a084]" />
      <input
        id={`tag-search-${target.id}`}
        className={`${styles.input()} pl-[28px]`}
        value={query}
        role="combobox"
        aria-expanded="true"
        aria-controls={`tag-options-${target.id}`}
        aria-activedescendant={results[activeIndex] ? `tag-option-${target.id}-${results[activeIndex].id}` : undefined}
        onChange={e => { if (tagNameLength(e.target.value) <= 20) setQuery(e.target.value) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1) }
          else if (e.key === 'Home') { e.preventDefault(); setActiveIndex(0) }
          else if (e.key === 'End') { e.preventDefault(); setActiveIndex(Math.max(0, results.length - 1)) }
          else if (e.key === 'Enter') { e.preventDefault(); void submitSearch() }
        }}
        placeholder="输入标签名称，回车创建或选中"
        autoFocus={autoFocus}
      />
    </div>
    <ColorPicker value={color} onChange={setColor} />
    {normalizedQuery && !exact && <p className={styles.hint()}>按回车创建「{normalizedQuery}」{color === 'transparent' ? '，透明时使用灰色' : ''}。</p>}
    <div id={`tag-options-${target.id}`} className={styles.list()} role="listbox" aria-label="可选标签">
      {results.length ? results.map((tag, index) => {
        const selected = assigned.includes(tag.id)
        const active = index === activeIndex
        return <div
          key={tag.id}
          id={`tag-option-${target.id}-${tag.id}`}
          role="option"
          aria-selected={selected}
          data-active={active}
          className={`${styles.row()} ${active ? 'bg-[#f3f6ef] shadow-[inset_0_0_0_1px_#c7d5b8]' : ''} ${selected ? 'bg-[#e6eeda] text-[#425636]' : ''}`}
          onMouseMove={() => setActiveIndex(index)}
          onClick={() => void setAssigned(tag)}
        >
          <span className="grid h-[16px] w-[16px] shrink-0 place-items-center">{selected && <Check size={14} className="text-[#557240]" />}</span>
          <span className="min-w-0 truncate"><TagChip tag={tag} /></span>
          <Button size="custom" className="h-[24px] w-[24px] shrink-0 p-0 text-[#7b8970] hover:bg-[#e3ebda]" aria-label={`编辑标签 ${tag.title}`} onClick={event => { event.stopPropagation(); setEditing(tag) }}><Pencil size={12} /></Button>
        </div>
      }) : <p className={styles.empty()}>{normalizedQuery ? '回车即可创建标签' : '暂无标签'}</p>}
    </div>
    {editing && <TagEditModal tag={editing} doc={doc} act={act} close={() => setEditing(null)} />}
  </div>
}

export function TagAssignmentField({ doc, target, act }: { doc: Document; target: TaggedEntity; act: TagAct }) {
  const currentTarget = (doc.entities[target.id] as TaggedEntity | undefined) ?? target
  const tags = activeTags(doc).filter(tag => (currentTarget.tagIds ?? []).includes(tag.id))
  return <div className="mt-[16px]">
    <div className="flex items-center justify-between gap-[8px]">
      <span className="text-[11px] font-semibold text-form-label">标签</span>
      {tags.length > 0 && <span className="text-[9px] text-ui-muted">{tags.length} 个标签</span>}
    </div>
    {tags.length > 0 && <div className="mt-[7px] flex flex-wrap gap-[5px]">{tags.map(tag => <span key={tag.id} className="inline-flex items-center gap-[3px]">
      <TagChip tag={tag} />
      <Button size="custom" className="h-[18px] w-[18px] p-0 text-[#82917a]" aria-label={`移除标签 ${tag.title}`} onClick={() => void act({ type: 'set-tags', id: currentTarget.id, tagIds: (currentTarget.tagIds ?? []).filter(id => id !== tag.id) })}><X size={11} /></Button>
    </span>)}</div>}
    <div className="mt-[8px] rounded-[10px] border border-solid border-[#e0e8d8] bg-[#f8faf4] p-[8px]">
      <TagPicker doc={doc} target={currentTarget} act={act} embedded autoFocus />
    </div>
  </div>
}

export function TagEditModal({ tag, doc, act, close }: { tag: TagRecord; doc: Document; act: TagAct; close: () => void }) {
  const [name, setName] = useState(tag.title)
  const [color, setColor] = useState<TagColorChoice>(tag.color)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const nameLength = tagNameLength(name.trim())

  async function save() {
    if (!name.trim() || nameLength > 20 || color === 'transparent') return
    setBusy(true)
    if (await act({ type: 'edit-tag', id: tag.id, name, color: color as TagColor })) close()
    setBusy(false)
  }

  return <>{!confirmDelete ? <Modal title="编辑标签" close={close}>
    <label className="block text-[11px] font-semibold text-form-label">名称
      <input className="mt-[7px] w-full rounded-[8px] border border-solid border-form-line bg-form-surface px-[11px] py-[9px] text-[12px] outline-none focus:border-form-focus" value={name} onChange={e => { if (tagNameLength(e.target.value) <= 20) setName(e.target.value) }} autoFocus />
    </label>
    <div className="mt-[16px]"><span className="block text-[11px] font-semibold text-form-label">颜色</span><ColorPicker value={color} onChange={setColor} allowTransparent={false} /></div>
    <div className="mt-[24px] flex items-center justify-between">
      <Button tone="danger" size="custom" className="px-[11px] py-[8px] text-[10px]" onClick={() => setConfirmDelete(true)}><Trash2 size={13} />删除标签</Button>
      <div className="flex gap-[8px]"><Button onClick={close}>取消</Button><Button tone="primary" disabled={busy || !name.trim() || nameLength > 20 || color === 'transparent'} onClick={() => void save()}>保存</Button></div>
    </div>
  </Modal> : <Modal title="永久删除标签" close={() => setConfirmDelete(false)}>
    <p className="text-[13px]">将从所有收藏块和卡片移除「{tag.title}」，且不可恢复。</p>
    <div className="mt-[24px] flex justify-end gap-[8px]"><Button onClick={() => setConfirmDelete(false)}>取消</Button><Button tone="danger" disabled={busy} onClick={async () => { setBusy(true); if (await act({ type: 'delete-tag', id: tag.id })) close(); setBusy(false) }}>永久删除</Button></div>
  </Modal>}</>
}

export function TagActionMenu({
  doc,
  target,
  label,
  act,
  onDelete,
  deleteLabel,
  placement = 'card',
  children,
}: {
  doc: Document
  target: TaggedEntity
  label: string
  act: TagAct
  onDelete: () => void
  deleteLabel: string
  placement?: 'card' | 'collection'
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) { setOpen(false); setTagOpen(false) } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); setTagOpen(false) } }
    window.addEventListener('click', close)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', escape) }
  }, [])
  return <div ref={rootRef} className="relative z-[40]">
    <Button tone="custom" size="custom" className={actionTrigger({ placement })} aria-label={`更多操作 ${label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><MoreHorizontal size={16} /></Button>
    {open && <div role="menu" aria-label={`${label}操作`} className="absolute right-0 top-[calc(100%+5px)] z-[90] w-[150px] rounded-[10px] border border-solid border-[#d7e2cc] bg-[#fffffdec] p-[5px] shadow-[0_18px_44px_#334c2b2b]">
      <button type="button" role="menuitem" className="flex w-full items-center gap-[7px] rounded-[7px] border-0 bg-transparent px-[8px] py-[8px] text-left text-[11px] text-ui-ink hover:bg-[#edf3e4]" onMouseEnter={() => setTagOpen(true)} onFocus={() => setTagOpen(true)} onClick={() => setTagOpen(true)}><Tag size={13} />标签</button>
      {children}
      <button type="button" role="menuitem" className="flex w-full items-center gap-[7px] rounded-[7px] border-0 bg-transparent px-[8px] py-[8px] text-left text-[11px] text-action-danger hover:bg-action-danger-hover" onClick={() => { setOpen(false); onDelete() }}><Trash2 size={13} />{deleteLabel}</button>
    </div>}
    {open && tagOpen && <div className="absolute left-[calc(100%+8px)] top-0 z-[100]" onMouseEnter={() => setTagOpen(true)}>
      <TagPicker doc={doc} target={target} act={act} />
    </div>}
  </div>
}

export function TagFilterButton({ doc, spaceId, value, onChange }: { doc: Document; spaceId: string; value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [color, setColor] = useState<TagColorChoice>('transparent')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('click', close)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', escape) }
  }, [])

  const usedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entity of active(doc)) {
      if (entity.kind !== 'collection' && entity.kind !== 'link' && entity.kind !== 'note') continue
      if (entity.kind === 'collection' && entity.parentId !== spaceId) continue
      if (entity.kind !== 'collection' && doc.entities[entity.parentId ?? '']?.parentId !== spaceId) continue
      for (const id of entity.tagIds ?? []) ids.add(id)
    }
    return ids
  }, [doc, spaceId])

  const tags = activeTags(doc).filter(tag =>
    usedIds.has(tag.id) &&
    (!query.trim() || tag.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) &&
    (color === 'transparent' || tag.color === color)
  )

  useEffect(() => {
    setActiveIndex(0)
  }, [query, color, tags.length])

  function toggleTag(tag: TagRecord) {
    onChange(value.includes(tag.id) ? value.filter(id => id !== tag.id) : [...value, tag.id])
  }

  function moveActive(delta: number) {
    if (!tags.length) return
    setActiveIndex(index => (index + delta + tags.length) % tags.length)
  }

  return <div ref={rootRef} className="relative">
    <button type="button" className={styles.filterButton()} aria-label="筛选" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Filter size={14} />
      {value.length > 0 && <span className="rounded-[5px] bg-[#dfe9d4] px-[5px] py-[2px] text-[9px]">{value.length}</span>}
    </button>
    {open && <div role="dialog" aria-label="筛选收藏" className="absolute left-0 top-[calc(100%+6px)] z-[80] w-[286px] rounded-[12px] border border-solid border-[#d7e2cc] bg-[#fffffdec] p-[12px] shadow-[0_18px_50px_#334c2b2b]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-form-label">筛选标签</span>
        {value.length > 0 && <Button size="custom" className="px-[5px] py-[3px] text-[9px]" onClick={() => onChange([])}>清空</Button>}
      </div>
      <div className="relative mt-[8px]">
        <Search size={13} className="absolute left-[9px] top-[9px] text-[#91a084]" />
        <input
          className={`${styles.input()} pl-[28px]`}
          aria-label="筛选标签"
          role="combobox"
          aria-expanded="true"
          aria-controls="space-filter-tags"
          aria-activedescendant={tags[activeIndex] ? `space-filter-tag-${tags[activeIndex].id}` : undefined}
          value={query}
          onChange={event => { if (tagNameLength(event.target.value) <= 20) setQuery(event.target.value) }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1) }
            else if (event.key === 'Home') { event.preventDefault(); setActiveIndex(0) }
            else if (event.key === 'End') { event.preventDefault(); setActiveIndex(Math.max(0, tags.length - 1)) }
            else if (event.key === 'Enter' && tags[activeIndex]) { event.preventDefault(); toggleTag(tags[activeIndex]) }
          }}
          placeholder="搜索标签"
          autoFocus
        />
      </div>
      <ColorPicker value={color} onChange={setColor} />
      <div id="space-filter-tags" className="mt-[10px] max-h-[220px] overflow-y-auto space-y-[6px]" role="listbox" aria-label="标签选项">
        {tags.length ? tags.map((tag, index) => {
          const selected = value.includes(tag.id)
          const active = index === activeIndex
          return <div
            key={tag.id}
            id={`space-filter-tag-${tag.id}`}
            role="option"
            aria-selected={selected}
            data-active={active}
            className={`${styles.row()} ${active ? 'bg-[#f3f6ef] shadow-[inset_0_0_0_1px_#c7d5b8]' : ''} ${selected ? 'bg-[#e6eeda] text-[#425636]' : ''}`}
            onMouseMove={() => setActiveIndex(index)}
            onClick={() => toggleTag(tag)}
          >
            <span className="grid h-[16px] w-[16px] shrink-0 place-items-center">{selected && <Check size={14} className="text-[#557240]" />}</span>
            <span className="min-w-0 truncate"><TagChip tag={tag} /></span>
            <span />
          </div>
        }) : <p className={styles.empty()}>没有匹配标签</p>}
      </div>
    </div>}
  </div>
}
