import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Check } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { todos, type Document, type Link } from '../core/model'
import type { Act } from './Editor'
import { useDragItem } from './drag'
import { Empty } from './Library'
import { Button, SiteIcon } from './ui'

const todo = tv({
  slots: {
    list: 'todo-list m-0 p-0 list-none flex flex-col gap-[1px] rounded-[16px] overflow-hidden bg-[#ffffff45] border border-solid border-[#fffefa]',
    row: 'todo-row relative flex items-center gap-[14px] px-[22px] py-[19px] min-h-[76px] bg-[#ffffff36] border-0 border-b border-solid border-[#e1e8d875] last:border-b-0 outline-offset-[-3px] transition-colors duration-200 hover:bg-[#f8ffefad] [@media(max-width:650px)]:px-[13px] [@media(max-width:650px)]:py-[17px] [@media(max-width:650px)]:gap-[10px]',
    complete: 'h-[22px] w-[22px] shrink-0 p-0 rounded-full border-[1.5px] border-solid border-[#c4cfb6] bg-[#ffffff8a] text-transparent hover:text-[var(--sage)] hover:bg-[#e6eddd] focus-visible:text-[var(--sage)] focus-visible:bg-[#e6eddd]',
    title: 'min-w-0 truncate flex-1 text-[14px] font-medium hover:text-[var(--sage-deep)] [@media(max-width:650px)]:text-[12px]',
  },
})
const styles = todo()

export default function TodoList({ doc, act }: { doc: Document; act: Act }) {
  const links = todos(doc)
  return <SortableContext items={links.map(link => `todo:${link.id}`)} strategy={verticalListSortingStrategy}>
    {links.length ? <ul className={styles.list()} aria-label="待办清单">{links.map(link => <TodoRow key={link.id} link={link} act={act} />)}</ul> : <Empty icon="todo" title="暂无待办" text="" />}
  </SortableContext>
}

function TodoRow({ link, act }: { link: Link; act: Act }) {
  const drag = useDragItem(`todo:${link.id}`, { kind: 'todo', entityId: link.id, title: link.title }, styles.row())
  return <li {...drag}>
    <Button tone="custom" size="custom" className={styles.complete()} aria-label="完成待办" onClick={() => void act({ type: 'todo', id: link.id, value: false })}><Check size={15} /></Button>
    <SiteIcon size="compact" className="opacity-85 [@media(max-width:650px)]:hidden" url={link.icon} title={link.title} />
    <a className={styles.title()} href={link.url} target="_blank" rel="noreferrer" draggable={false}>{link.title}</a>
  </li>
}
