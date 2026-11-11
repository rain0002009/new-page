import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { tv, type VariantProps } from 'tailwind-variants/lite'
import { X, Globe2 } from 'lucide-react'

const button = tv({
  base: 'inline-flex items-center justify-center gap-2 whitespace-nowrap [font-weight:550] transition-colors cursor-pointer disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ui-focus outline-offset-[3px]',
  variants: {
    tone: {
      custom: '',
      primary: 'rounded-[9px] border border-solid border-[#71865b] text-white bg-[linear-gradient(140deg,#82966b,#617c4d)] shadow-[inset_0_1px_0_#aebf9677,0_5px_13px_#4e684b1f] hover:bg-[linear-gradient(140deg,#8ba674,#55723e)] hover:shadow-[0_6px_20px_#4e684b30]',
      ghost: 'rounded-[9px] border border-solid border-transparent bg-transparent text-action-ghost hover:bg-action-ghost-surface hover:text-action-ghost-hover',
      danger: 'rounded-[9px] border border-solid border-transparent bg-action-danger-surface text-action-danger hover:bg-action-danger-hover',
    },
    size: { regular: 'px-[13px] py-[9px] text-[12px]', icon: 'h-[32px] w-[32px] shrink-0 p-0', custom: '' },
  },
  defaultVariants: { tone: 'ghost', size: 'regular' },
})
export function Button({ tone, size, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button type="button" className={button({ tone, size, className })} {...props} onMouseDown={event => { event.stopPropagation(); props.onMouseDown?.(event) }} onTouchStart={event => { event.stopPropagation(); props.onTouchStart?.(event) }} />
}
const modal = tv({
  slots: {
    dialog: 'm-auto rounded-[18px] border border-solid border-white bg-ui-dialog p-[25px] max-h-[86vh] text-ui-ink shadow-[0_25px_100px_#334c2b2e] backdrop-blur-[25px] [&::backdrop]:bg-[#3a4b2e30] [&::backdrop]:[backdrop-filter:blur(8px)]',
    header: 'flex items-start justify-between',
    title: 'mt-[6px] text-[20px] [font-weight:550]',
  },
  variants: {
    size: {
      regular: { dialog: 'w-[min(470px,calc(100vw-32px))] overflow-y-auto', header: 'mb-[24px]' },
      wide: { dialog: 'w-[min(720px,calc(100vw-32px))] overflow-y-auto', header: 'mb-[24px]' },
      search: { dialog: 'w-[min(860px,calc(100vw-32px))] h-[min(720px,85vh)] open:flex flex-col overflow-hidden', header: 'mb-[18px] shrink-0' },
    },
  },
  defaultVariants: { size: 'regular' },
})

export function Modal({ title, children, close, size, className }: { title: string; children: ReactNode; close: () => void; className?: string } & VariantProps<typeof modal>) {
  const ref = useRef<HTMLDialogElement>(null)
  const styles = modal({ size })
  useEffect(() => { ref.current?.showModal(); ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus() }, [])
  return <dialog ref={ref} aria-label={title} className={styles.dialog({ className })} onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.target === event.currentTarget) close() }}>
    <div className={styles.header()}><h2 className={styles.title()}>{title}</h2><Button size="icon" aria-label="关闭弹窗" onClick={close}><X size={19} /></Button></div>
    {children}
  </dialog>
}
const siteIcon = tv({
  slots: {
    icon: 'site-icon relative grid shrink-0 place-items-center overflow-hidden rounded-[8px] bg-ui-icon text-ui-icon-fallback shadow-[inset_0_1px_2px_#fff,0_3px_8px_#637b3f0a]',
    image: 'absolute z-1 h-[20px] w-[20px] bg-ui-icon-image object-contain',
  },
  variants: { size: { regular: { icon: 'h-[30px] w-[30px]' }, small: { icon: 'h-[28px] w-[28px]' }, compact: { icon: 'h-[26px] w-[26px]' } } },
  defaultVariants: { size: 'regular' },
})

export function SiteIcon({ url = '', title, size, className }: { url?: string; title: string; className?: string } & VariantProps<typeof siteIcon>) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const styles = siteIcon({ size })
  return <span className={styles.icon({ className })} aria-hidden="true" title={title}>{url && url !== failedUrl ? <img className={styles.image()} src={url} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} /> : null}<Globe2 size={20} /></span>
}
