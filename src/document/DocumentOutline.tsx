import { markdownOutline } from '../core/markdown'
import { Button } from '../newtab/ui'

export default function DocumentOutline({ body }: { body: string }) {
  const headings = markdownOutline(body)
  const indent = ['pl-0', 'pl-[10px]', 'pl-[20px]', 'pl-[30px]', 'pl-[40px]', 'pl-[50px]']
  return <nav aria-label="文档大纲" className="max-h-[65vh] overflow-auto [@media(max-width:650px)]:max-h-[180px]">
    {headings.length ? <ol className="list-none p-0 m-0">{headings.map((heading, index) => <li key={index} className={indent[heading.depth - 1]}><Button tone="custom" size="custom" className="block w-full py-[8px] px-[5px] text-left text-[12px] text-ui-sage bg-transparent border-0 rounded-[6px] hover:bg-ui-surface [overflow-wrap:anywhere]" onClick={() => {
      const target = document.querySelectorAll<HTMLElement>('.milkdown h1, .milkdown h2, .milkdown h3, .milkdown h4, .milkdown h5, .milkdown h6')[index]
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }) }
    }}>{heading.title || '无标题'}</Button></li>)}</ol> : <p className="text-[11px] text-ui-muted py-[12px]">正文中的标题会显示在这里</p>}
  </nav>
}
