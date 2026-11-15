import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'

export const motionEase = 'cubic-bezier(.22,.7,.2,1)'
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function translation(transform: string) {
  const matrix = new DOMMatrixReadOnly(transform === 'none' || !transform ? undefined : transform)
  return { x: matrix.m41, y: matrix.m42 }
}

// Animate the visual transform, leaving the final layout available to dnd-kit's
// transform-agnostic collision measurements throughout the transition.
export function useLayoutMotion(ref: RefObject<HTMLElement>, selector: string) {
  const previous = useRef(new Map<string, { x: number; y: number; node: HTMLElement; animation?: Animation }>())
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    // Height animations move later siblings without a React render; keep their
    // layout baseline current so the next render does not replay that movement.
    const observer = new ResizeObserver(() => {
      const rootRect = root.getBoundingClientRect()
      for (const entry of previous.current.values()) {
        if (!entry.node.isConnected) continue
        const rect = entry.node.getBoundingClientRect()
        const transform = translation(getComputedStyle(entry.node).transform)
        entry.x = rect.x - rootRect.x - transform.x
        entry.y = rect.y - rootRect.y - transform.y
      }
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const rootRect = root.getBoundingClientRect()
    const next = new Map<string, { x: number; y: number; node: HTMLElement; animation?: Animation }>()
    for (const node of root.querySelectorAll<HTMLElement>(selector)) {
      const id = node.dataset.dragId ?? node.dataset.motionId
      if (!id) continue
      const rect = node.getBoundingClientRect()
      const transform = translation(getComputedStyle(node).transform)
      const base = translation(node.style.transform)
      const x = rect.x - rootRect.x - transform.x
      const y = rect.y - rootRect.y - transform.y
      const old = previous.current.get(id)
      const entry = { x, y, node, animation: old?.animation }
      next.set(id, entry)
      if (reducedMotion()) { old?.animation?.cancel(); continue }
      if (!old) {
        entry.animation = node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: motionEase })
        continue
      }
      if (Math.abs(old.x - x) < .5 && Math.abs(old.y - y) < .5) continue
      const running = old.animation?.playState === 'running'
      const current = running && old.node === node ? translation(getComputedStyle(node).transform) : base
      const dx = old.x - x + current.x - base.x
      const dy = old.y - y + current.y - base.y
      old.animation?.cancel()
      if (node.hasAttribute('data-dragging')) continue
      const underlying = node.style.transform || 'translate(0px, 0px)'
      entry.animation = node.animate([
        { transform: `translate(${dx}px, ${dy}px) ${underlying}` },
        { transform: underlying },
      ], { duration: 240, easing: motionEase })
    }
    for (const [id, old] of previous.current) if (!next.has(id)) old.animation?.cancel()
    previous.current = next
  })
  useLayoutEffect(() => () => { previous.current.forEach(entry => entry.animation?.cancel()); previous.current.clear() }, [])
}

// The inner node keeps its natural height while the outer node animates. This
// also covers grid/empty-state switches and temporary expansion while dragging.
export function MotionRegion({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const height = useRef<number>()
  const animation = useRef<Animation>()
  useLayoutMotion(inner, '.card-grid > [data-drag-id], .card-grid > [data-motion-id]')
  useLayoutEffect(() => {
    const node = outer.current!
    const content = inner.current!
    const update = () => {
      const next = content.getBoundingClientRect().height
      if (height.current === next) return
      const from = animation.current?.playState === 'running' ? node.getBoundingClientRect().height : height.current ?? next
      animation.current?.cancel()
      node.style.overflow = ''
      height.current = next
      if (Math.abs(from - next) > .5 && !reducedMotion()) {
        node.style.overflow = 'clip'
        const current = node.animate([{ height: `${from}px` }, { height: `${next}px` }], { duration: 240, easing: motionEase })
        animation.current = current
        void current.finished.then(() => { if (animation.current === current) node.style.overflow = '' }).catch(() => {})
      }
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(content)
    return () => observer.disconnect()
  })
  useLayoutEffect(() => () => animation.current?.cancel(), [])
  return <div ref={outer}><div ref={inner}>{children}</div></div>
}
