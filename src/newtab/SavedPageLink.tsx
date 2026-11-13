import { useState, type AnchorHTMLAttributes, type MouseEvent } from 'react'
import { savedUrl } from '../core/model'
import { feedbackStyles } from './form-styles'

export default function SavedPageLink({ href, children, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'onAuxClick'> & { href: string }) {
  const [error, setError] = useState('')
  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button > 1 || /^https?:/i.test(href)) return
    event.preventDefault()
    setError('')
    // Browser and file pages cannot be opened through ordinary extension anchors.
    void chrome.tabs.create({ url: savedUrl(href), active: event.button === 0 && !event.ctrlKey && !event.metaKey }).catch(() => {
      setError('无法打开此页面，请检查页面是否仍可用，或复制网址到地址栏打开')
    })
  }
  return <><a {...props} href={href} target="_blank" rel="noreferrer" draggable={false} onClick={open} onAuxClick={open}>{children}</a>{error && <span role="alert" className={feedbackStyles.error()}>{error}</span>}</>
}
