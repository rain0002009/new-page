import { useEffect, useRef, type ReactNode } from 'react'
import { OverlayScrollbarsComponent, type OverlayScrollbarsComponentRef } from 'overlayscrollbars-react'
import { tv } from 'tailwind-variants/lite'
import 'overlayscrollbars/overlayscrollbars.css'

const panel = tv({
  slots: {
    base: 'main-content relative z-2 min-w-0 min-h-0 h-[calc(100dvh-40px)] my-[20px] mx-[8px] flex flex-col overflow-hidden bg-[linear-gradient(145deg,#ffffff85,#fffffb66)] [backdrop-filter:blur(24px)_saturate(110%)] border border-solid border-[#ffffffc7] rounded-[28px] shadow-[0_22px_65px_-24px_#35463242,0_5px_16px_-7px_#35463226,inset_0_1px_0_#fff] [@media(max-width:650px)]:mt-[10px] [@media(max-width:650px)]:mr-[10px] [@media(max-width:650px)]:mb-[10px] [@media(max-width:650px)]:ml-0 [@media(max-width:650px)]:h-[calc(100dvh-20px)] [@media(max-width:650px)]:rounded-[20px]',
    heading: 'relative z-2 shrink-0 px-[32px] after:content-empty after:absolute after:left-[32px] after:right-[32px] after:bottom-0 after:h-[1px] after:bg-[linear-gradient(90deg,#71865b18,#ffffff70,#71865b18)] after:pointer-events-none [@media(max-width:650px)]:px-[16px] [@media(max-width:650px)]:after:left-[16px] [@media(max-width:650px)]:after:right-[16px]',
    scroll: 'content-scroll flex-1 min-h-0 min-w-0',
    body: 'content-body flow-root pt-[6px] px-[32px] pb-[40px] [@media(max-width:1000px)]:pb-[80px] [@media(max-width:650px)]:px-[16px]',
  },
})
const styles = panel()

export default function ContentPanel({ header, children, scrollKey }: { header: ReactNode; children: ReactNode; scrollKey: string }) {
  const scroll = useRef<OverlayScrollbarsComponentRef>(null)
  useEffect(() => { scroll.current?.osInstance()?.elements().viewport.scrollTo(0, 0) }, [scrollKey])

  return <main className={styles.base()}>
    <div className={styles.heading()}>{header}</div>
    <OverlayScrollbarsComponent ref={scroll} className={styles.scroll()} data-overlayscrollbars-initialize options={{
      overflow: { x: 'hidden', y: 'scroll' },
      scrollbars: { theme: 'os-theme-garden', autoHide: 'leave', autoHideDelay: 650, autoHideSuspend: true, clickScroll: 'instant' },
    }} events={{ initialized: instance => {
      const viewport = instance.elements().viewport
      viewport.tabIndex = 0
      viewport.setAttribute('role', 'region')
      viewport.setAttribute('aria-label', '页面内容')
    } }}>
      <div className={styles.body()}>{children}</div>
    </OverlayScrollbarsComponent>
  </main>
}
