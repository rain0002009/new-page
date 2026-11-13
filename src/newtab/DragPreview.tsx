import { useLayoutEffect, useRef } from 'react'
import type { DropAnimationFunctionArguments } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { OpenTab } from './open-tabs'
import { linkCard } from './link-card-styles'
import { SiteIcon } from './ui'
import { motionEase, reducedMotion } from './motion'
import { pageLabel } from '../core/model'

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
  clone.style.setProperty('--source-width', `${rect.width}`)
  clone.style.setProperty('--source-height', `${rect.height}`)
  const original = source.querySelectorAll<HTMLElement>('*')
  clone.querySelectorAll<HTMLElement>('*').forEach((node, index) => { node.style.opacity = getComputedStyle(original[index]).opacity })
  return clone
}

export default function DragPreview({ element, tab, card, collectionId }: { element: HTMLElement; tab?: OpenTab; card: boolean; collectionId?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const snapshot = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const animations = useRef<Animation[]>([])
  const initialized = useRef(false)
  useLayoutEffect(() => {
    const host = snapshot.current!
    element.style.width = '100%'
    element.style.height = '100%'
    host.replaceChildren(element)
    return () => { host.replaceChildren() }
  }, [element])
  useLayoutEffect(() => {
    const node = ref.current!
    const original = snapshot.current!
    const destination = cardRef.current
    const from = node.getBoundingClientRect()
    const oldOpacity = getComputedStyle(original).opacity
    const newOpacity = destination ? getComputedStyle(destination).opacity : '0'
    animations.current.forEach(animation => animation.cancel())
    const collection = collectionId ? document.querySelector(`[data-drag-id="${window.CSS.escape(collectionId)}"]`) : document.querySelector('.main-content')
    const cell = collection?.querySelector('.card-placeholder, .link-card')
    const width = card ? cell?.getBoundingClientRect().width ?? 240 : parseFloat(element.style.getPropertyValue('--source-width'))
    if (destination) destination.style.width = `${width}px`
    const height = card ? destination!.getBoundingClientRect().height : parseFloat(element.style.getPropertyValue('--source-height'))
    node.style.width = `${width}px`
    node.style.height = `${height}px`
    original.style.opacity = card ? '0' : '1'
    if (destination) destination.style.opacity = card ? '1' : '0'
    if (initialized.current && !reducedMotion()) {
      const options = { duration: 220, easing: motionEase }
      animations.current = [
        node.animate([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${width}px`, height: `${height}px` }], options),
        original.animate([{ opacity: oldOpacity }, { opacity: card ? 0 : 1 }], options),
        ...(destination ? [destination.animate([{ opacity: newOpacity }, { opacity: card ? 1 : 0 }], options)] : []),
      ]
    }
    initialized.current = true
  }, [element, tab, card, collectionId])
  useLayoutEffect(() => () => animations.current.forEach(animation => animation.cancel()), [])
  const styles = linkCard()
  return <div className="drag-preview relative max-w-none p-0 border-0 bg-none overflow-visible whitespace-normal rounded-[15px] shadow-[0_18px_38px_#3443282b] text-[13px] text-ui-ink cursor-grabbing" ref={ref} aria-hidden="true">
    <div className="drag-preview-content absolute inset-0">
      <div ref={snapshot} data-preview-layer className="absolute inset-0" />
      {tab && <div ref={cardRef} data-preview-layer className="absolute top-0 left-0 opacity-0"><article className={styles.base()}><div className={styles.top()}><SiteIcon url={tab.icon || ''} title={tab.title} /></div><span className={styles.title()}>{tab.title}</span><span className={styles.domain()}>{pageLabel(tab.url)}</span></article></div>}
    </div>
  </div>
}

export async function animateDrop({ dragOverlay, transform }: DropAnimationFunctionArguments, target: HTMLElement | null) {
  if (reducedMotion()) return
  const preview = dragOverlay.node.querySelector<HTMLElement>('.drag-preview')
  if (!preview) return
  const from = dragOverlay.node.getBoundingClientRect()
  // Freeze an unfinished tab/card morph before handing its geometry to drop.
  const layers = [...preview.querySelectorAll<HTMLElement>('[data-preview-layer]')]
  const opacity = layers.map(node => getComputedStyle(node).opacity)
  preview.getAnimations({ subtree: true }).forEach(animation => animation.cancel())
  preview.style.width = `${from.width}px`
  preview.style.height = `${from.height}px`
  layers.forEach((node, i) => { node.style.opacity = opacity[i] })
  if (!target?.isConnected) {
    const fade = dragOverlay.node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' })
    await fade.finished.catch(() => {})
    dragOverlay.node.style.opacity = '0'
    fade.cancel()
    return
  }
  let to = target.getBoundingClientRect()
  const destination = snapshotElement(target)
  destination.style.position = 'absolute'
  destination.style.inset = '0'
  destination.style.width = '100%'
  destination.style.height = '100%'
  destination.style.visibility = 'visible'
  const original = preview.querySelector<HTMLElement>('.drag-preview-content')
  if (!original) return
  original.style.width = '100%'
  original.style.height = '100%'
  preview.style.position = 'relative'
  preview.append(destination)
  const hidden = hiddenTargets.get(target) ?? { visibility: target.style.visibility, count: 0 }
  hidden.count++
  hiddenTargets.set(target, hidden)
  target.style.visibility = 'hidden'
  const options: KeyframeAnimationOptions = { duration: 320, easing: motionEase, fill: 'forwards' }
  const animations = [
    dragOverlay.node.animate([
      { transform: CSS.Transform.toString(transform) },
      { transform: CSS.Transform.toString({ ...transform, x: transform.x + to.x - from.x, y: transform.y + to.y - from.y }) },
    ], options),
    preview.animate([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }], options),
    original.animate([{ opacity: 1 }, { opacity: 0 }], options),
    destination.animate([{ opacity: 0 }, { opacity: 1 }], options),
  ]
  let frame = 0
  const started = performance.now()
  const follow = () => {
    if (!target.isConnected || performance.now() - started > 320) return
    const next = target.getBoundingClientRect()
    if (Math.abs(next.x - to.x) + Math.abs(next.y - to.y) + Math.abs(next.width - to.width) + Math.abs(next.height - to.height) > .5) {
      to = next
      const move = animations[0].effect as KeyframeEffect
      const size = animations[1].effect as KeyframeEffect
      move.setKeyframes([
        { transform: CSS.Transform.toString(transform) },
        { transform: CSS.Transform.toString({ ...transform, x: transform.x + to.x - from.x, y: transform.y + to.y - from.y }) },
      ])
      size.setKeyframes([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }])
    }
    frame = requestAnimationFrame(follow)
  }
  frame = requestAnimationFrame(follow)
  try { await Promise.all(animations.map(animation => animation.finished.catch(() => {}))) }
  finally {
    cancelAnimationFrame(frame)
    // React removes the overlay after this promise resolves. Hide it before
    // cancelling the fill, which otherwise flashes its original drop position.
    dragOverlay.node.style.opacity = '0'
    if (!--hidden.count) { target.style.visibility = hidden.visibility; hiddenTargets.delete(target) }
    animations.forEach(animation => animation.cancel())
  }
}
