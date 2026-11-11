import { useEffect, useRef, type ReactNode } from 'react'
import { OverlayScrollbarsComponent, type OverlayScrollbarsComponentRef } from 'overlayscrollbars-react'
import 'overlayscrollbars/overlayscrollbars.css'

export default function ContentPanel({ header, children, scrollKey }: { header: ReactNode; children: ReactNode; scrollKey: string }) {
  const scroll = useRef<OverlayScrollbarsComponentRef>(null)
  useEffect(() => { scroll.current?.osInstance()?.elements().viewport.scrollTo(0, 0) }, [scrollKey])

  return <main className="main-content">
    <div className="content-heading">{header}</div>
    <OverlayScrollbarsComponent ref={scroll} className="content-scroll" data-overlayscrollbars-initialize options={{
      overflow: { x: 'hidden', y: 'scroll' },
      scrollbars: { theme: 'os-theme-garden', autoHide: 'leave', autoHideDelay: 650, autoHideSuspend: true, clickScroll: 'instant' },
    }} events={{ initialized: instance => {
      const viewport = instance.elements().viewport
      viewport.tabIndex = 0
      viewport.setAttribute('role', 'region')
      viewport.setAttribute('aria-label', '页面内容')
    } }}>
      <div className="content-body">{children}</div>
    </OverlayScrollbarsComponent>
  </main>
}
