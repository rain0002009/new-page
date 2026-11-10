import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Check } from 'lucide-react'
import { todos, type Document, type Link } from '../core/model'
import type { Act } from './Editor'
import { useDragItem } from './drag'
import { Empty } from './Library'
import { Button, SiteIcon } from './ui'

export default function TodoList({ doc, act }: { doc: Document; act: Act }) {
  const links = todos(doc)
  return <SortableContext items={links.map(link => `todo:${link.id}`)} strategy={verticalListSortingStrategy}>
    {links.length ? <ul className="todo-list" aria-label="待办清单">{links.map(link => <TodoRow key={link.id} link={link} act={act} />)}</ul> : <Empty icon="todo" title="暂无待办" text="" />}
  </SortableContext>
}

function TodoRow({ link, act }: { link: Link; act: Act }) {
  const drag = useDragItem(`todo:${link.id}`, { kind: 'todo', entityId: link.id, title: link.title })
  return <li {...drag} className="todo-row">
    <Button className="todo-complete" size="icon" aria-label="完成待办" onClick={() => void act({ type: 'todo', id: link.id, value: false })}><Check size={15} /></Button>
    <SiteIcon url={link.icon} title={link.title} />
    <a href={link.url} target="_blank" rel="noreferrer" draggable={false}>{link.title}</a>
  </li>
}
