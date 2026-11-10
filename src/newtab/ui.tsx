import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { tv } from 'tailwind-variants/lite'
import { X, Globe2 } from 'lucide-react'

const button = tv({
  base: 'btn inline-flex items-center justify-center gap-2 transition-colors',
  variants: { tone: { primary: 'btn-primary', ghost: 'btn-ghost', danger: 'btn-danger' }, size: { regular: 'btn-regular', icon: 'btn-icon' } },
  defaultVariants: { tone: 'ghost', size: 'regular' },
})
export function Button({ tone, size, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger'; size?: 'regular' | 'icon' }) {
  return <button type="button" className={button({ tone, size, className })} {...props} />
}
export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} aria-label={title} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.target === event.currentTarget) close() }}>
    <div className="modal-header"><div><span className="eyebrow">YOUR LITTLE CORNER</span><h2>{title}</h2></div><Button size="icon" aria-label="关闭弹窗" onClick={close}><X size={19} /></Button></div>
    {children}
  </dialog>
}
export function SiteIcon({ url = '', title }: { url?: string; title: string }) {
  return <span className="site-icon" aria-hidden="true" title={title}>{url ? <img src={url} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none' }} /> : null}<Globe2 size={20} /></span>
}
