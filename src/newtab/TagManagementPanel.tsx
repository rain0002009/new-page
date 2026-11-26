import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, Link2, LocateFixed, Pencil, Search, Tag, Unlink } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { active, tagUsagesByTag, type Document, type TaggedEntity, type TagUsage, type Tag as TagRecord } from '../core/model'
import type { Act } from './Editor'
import { Button } from './ui'
import { ColorPicker, TagChip, TagEditModal } from './Tags'

type TagColorChoice = TagRecord['color'] | 'transparent'

const styles = tv({
  slots: {
    toolbar: 'flex items-center gap-[10px] mb-[18px] [@media(max-width:650px)]:flex-col [@media(max-width:650px)]:items-stretch',
    search: 'relative flex-1 min-w-0',
    searchInput: 'w-full rounded-[10px] border border-solid border-form-line bg-form-surface py-[9px] pl-[34px] pr-[12px] text-[12px] text-form-ink outline-none focus:border-form-focus focus:shadow-[0_0_0_3px_#eaf0df]',
    section: 'p-[25px] border border-solid border-white rounded-[13px] bg-ui-dialog mb-[20px] backdrop-blur-[25px] shadow-[0_10px_35px_#4c683410] [@media(max-width:650px)]:p-[18px]',
    sectionHeader: 'flex w-full items-center gap-[8px] rounded-[8px] border-0 bg-transparent p-0 text-left text-[15px] font-semibold text-ui-ink cursor-pointer',
    list: 'space-y-[8px]',
    tag: 'rounded-[12px] border border-solid border-[#e1e8d8] bg-[#fffffbd9] overflow-hidden',
    tagHeader: 'flex min-h-[52px] items-center gap-[10px] px-[14px] py-[10px]',
    expand: 'flex min-w-0 flex-1 items-center gap-[10px] bg-transparent border-0 p-0 text-left cursor-pointer',
    tagTitle: 'min-w-0 truncate text-[13px] font-semibold text-ui-ink',
    count: 'ml-auto shrink-0 rounded-[6px] bg-[#e8eee0] px-[7px] py-[3px] text-[10px] text-[#607250]',
    edit: 'h-[30px] w-[30px] shrink-0 rounded-[8px] border-0 bg-transparent text-action-ghost hover:bg-action-ghost-surface',
    usageList: 'border-t border-solid border-[#e5ebdd] bg-[#f8faf4] px-[12px] py-[8px] space-y-[4px]',
    usage: 'flex items-center gap-[10px] rounded-[8px] px-[8px] py-[7px] hover:bg-[#eef3e8]',
    usageIcon: 'grid h-[28px] w-[28px] shrink-0 place-items-center rounded-[8px] bg-[#e5eeda] text-[#607b4d]',
    usageBody: 'min-w-0 flex-1',
    usageTitle: 'block truncate text-[12px] font-medium text-ui-ink',
    usagePath: 'block truncate text-[10px] text-ui-muted mt-[2px]',
    usageActions: 'flex shrink-0 items-center gap-[4px]',
    action: 'h-[28px] w-[28px] rounded-[7px] border-0 bg-transparent text-action-ghost hover:bg-[#e3ebda]',
    empty: 'px-[12px] py-[14px] text-[11px] text-ui-muted',
  },
})

const panelStyles = styles()

function UsageIcon({ kind }: { kind: 'collection' | 'link' | 'note' }) {
  if (kind === 'collection') return <Folder size={15} />
  if (kind === 'link') return <Link2 size={15} />
  return <FileText size={15} />
}

export default function TagManagementPanel({ doc, act, onLocateEntity }: { doc: Document; act: Act; onLocateEntity: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [color, setColor] = useState<TagColorChoice>('transparent')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<TagRecord | null>(null)

  const tags = useMemo(() => active(doc)
    .filter((entity): entity is TagRecord => entity.kind === 'tag')
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN')), [doc])

  const visibleTags = tags.filter(tag =>
    (!query.trim() || tag.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) &&
    (color === 'transparent' || tag.color === color)
  )

  const usageMap = useMemo(() => tagUsagesByTag(doc), [doc])

  function toggleExpanded(id: string) {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function unbind(tagId: string, usage: TagUsage) {
    const target = doc.entities[usage.entityId] as TaggedEntity | undefined
    if (!target) return
    await act({ type: 'set-tags', id: target.id, tagIds: (target.tagIds ?? []).filter(id => id !== tagId) })
  }

  return <section className={panelStyles.section()} aria-label="标签管理内容">
    <button type="button" className={panelStyles.sectionHeader()} aria-expanded={!collapsed} aria-label={`${collapsed ? '展开' : '收起'}标签管理`} onClick={() => setCollapsed(value => !value)}>
      {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
      <Tag size={16} />
      <span>标签管理</span>
    </button>
    {!collapsed && <>
    <div className={panelStyles.toolbar()}>
      <div className={panelStyles.search()}>
        <Search size={15} className="absolute left-[11px] top-[10px] text-[#8d9b82]" />
        <input
          className={panelStyles.searchInput()}
          aria-label="搜索标签名称"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索标签名称"
          autoFocus
        />
      </div>
      <ColorPicker value={color} onChange={setColor} />
    </div>

    <div className={panelStyles.list()}>
      {visibleTags.length ? visibleTags.map(tag => {
        const usages = usageMap.get(tag.id) ?? []
        const isExpanded = expanded.has(tag.id)
        return <article key={tag.id} className={panelStyles.tag()}>
          <div className={panelStyles.tagHeader()}>
            <button
              type="button"
              className={panelStyles.expand()}
              aria-label={`${isExpanded ? '收起' : '展开'}标签 ${tag.title}`}
              aria-expanded={isExpanded}
              onClick={() => toggleExpanded(tag.id)}
            >
              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <TagChip tag={tag} />
              <span className={panelStyles.tagTitle()}>{tag.title}</span>
              <span className={panelStyles.count()}>{usages.length} 处使用</span>
            </button>
            <Button tone="custom" size="custom" className={panelStyles.edit()} aria-label={`编辑标签 ${tag.title}`} onClick={() => setEditing(tag)}><Pencil size={14} /></Button>
          </div>
          {isExpanded && <div className={panelStyles.usageList()}>
            {usages.length ? usages.map(usage => <div key={usage.entityId} className={panelStyles.usage()} aria-label={`用途 ${usage.title}`}>
              <span className={panelStyles.usageIcon()}><UsageIcon kind={usage.entityKind} /></span>
              <span className={panelStyles.usageBody()}>
                <strong className={panelStyles.usageTitle()}>{usage.title}</strong>
                <span className={panelStyles.usagePath()}>{usage.path.join(' / ')}</span>
              </span>
              <span className={panelStyles.usageActions()}>
                <Button tone="custom" size="custom" className={panelStyles.action()} aria-label={`定位 ${usage.title}`} onClick={() => onLocateEntity(usage.entityId)}><LocateFixed size={14} /></Button>
                <Button tone="custom" size="custom" className={panelStyles.action()} aria-label={`解绑 ${usage.title}`} onClick={() => void unbind(tag.id, usage)}><Unlink size={14} /></Button>
              </span>
            </div>) : <p className={panelStyles.empty()}>这个标签还没有被使用。</p>}
          </div>}
        </article>
      }) : <p className={panelStyles.empty()}>没有匹配的标签。</p>}
    </div>

    {editing && <TagEditModal tag={editing} doc={doc} act={act} close={() => setEditing(null)} />}
    </>}
  </section>
}

