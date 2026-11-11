import { useLayoutEffect, useRef } from 'react'
import type { DropAnimationFunctionArguments } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'

const hiddenTargets = new WeakMap<HTMLElement, { visibility: string; count: number }>()

// A detached DOM snapshot preserves the rendered object without registering a
// second sortable item or copying React event handlers into the overlay.
export function snapshotElement(source: HTMLElement) {
  const clone = source.cloneNode(true) as HTMLElement
  const rect = source.getBoundingClientRect()
  clone.removeAttribute('id')
  clone.removeAttribute('data-dragging')
  clone.removeAttribute('data-drop-target')
  clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'))
  clone.classList.remove('cursor-grab')
  clone.classList.add('drag-snapshot', 'cursor-grabbing')
  clone.inert = true
  clone.setAttribute('aria-hidden', 'true')
  Object.assign(clone.style, { width: `${rect.width}px`, height: `${rect.height}px`, minHeight: '0', margin: '0', transform: 'none', transition: 'none', opacity: '1', pointerEvents: 'none' })
  const original = source.querySelectorAll<HTMLElement>('*')
  clone.querySelectorAll<HTMLElement>('*').forEach((node, index) => { node.style.opacity = getComputedStyle(original[index]).opacity })
  return clone
}

export default function DragPreview({ element }: { element: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = ref.current!
    host.replaceChildren(element)
    return () => { host.replaceChildren() }
  }, [element])
  return <div className="drag-preview w-full h-full max-w-none p-0 border-0 bg-none overflow-visible whitespace-normal rounded-[15px] shadow-[0_18px_38px_#3443282b] text-[13px] text-ui-ink cursor-grabbing" ref={ref} aria-hidden="true" />
}

export async function animateDrop({ dragOverlay, transform }: DropAnimationFunctionArguments, target: HTMLElement | null) {
  if (!target?.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const preview = dragOverlay.node.querySelector<HTMLElement>('.drag-preview')
  if (!preview) return
  const from = dragOverlay.node.getBoundingClientRect()
  const to = target.getBoundingClientRect()
  const destination = snapshotElement(target)
  destination.style.position = 'absolute'
  destination.style.inset = '0'
  destination.style.width = '100%'
  destination.style.height = '100%'
  destination.style.visibility = 'visible'
  const original = preview.firstElementChild as HTMLElement
  if (!original) return
  original.style.width = '100%'
  original.style.height = '100%'
  preview.style.position = 'relative'
  preview.append(destination)
  const hidden = hiddenTargets.get(target) ?? { visibility: target.style.visibility, count: 0 }
  hidden.count++
  hiddenTargets.set(target, hidden)
  target.style.visibility = 'hidden'
  const options: KeyframeAnimationOptions = { duration: 320, easing: 'cubic-bezier(.22,.7,.2,1)', fill: 'forwards' }
  const animations = [
    dragOverlay.node.animate([
      { transform: CSS.Transform.toString(transform) },
      { transform: CSS.Transform.toString({ ...transform, x: transform.x + to.x - from.x, y: transform.y + to.y - from.y }) },
    ], options),
    preview.animate([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }], options),
    original.animate([{ opacity: 1 }, { opacity: 0 }], options),
    destination.animate([{ opacity: 0 }, { opacity: 1 }], options),
  ]
  try { await Promise.all(animations.map(animation => animation.finished.catch(() => {}))) }
  finally {
    // React removes the overlay after this promise resolves. Hide it before
    // cancelling the fill, which otherwise flashes its original drop position.
    dragOverlay.node.style.opacity = '0'
    if (!--hidden.count) { target.style.visibility = hidden.visibility; hiddenTargets.delete(target) }
    animations.forEach(animation => animation.cancel())
  }
}
