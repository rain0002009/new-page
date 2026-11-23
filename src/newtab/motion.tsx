import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

export const motionEase = 'cubic-bezier(.22,.7,.2,1)'
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function translation(transform: string) {
  const matrix = new DOMMatrixReadOnly(transform === 'none' || !transform ? undefined : transform)
  return { x: matrix.m41, y: matrix.m42 }
}

// Animate the visual transform, leaving the final layout available to dnd-kit's
// transform-agnostic collision measurements throughout the transition.
export function useLayoutMotion(ref: RefObject<HTMLElement>, selector: string, options?: { skipInitialFade?: boolean }) {
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
        if (!options?.skipInitialFade) {
          entry.animation = node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: motionEase })
        }
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
// also covers grid/empty-state switches, collapse/expand and temporary expansion while dragging.
export function MotionRegion({ children, open = true }: { children: ReactNode; open?: boolean }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const height = useRef<number>()
  const animation = useRef<Animation>()
  const isMounted = useRef(false)

  const [animatingClose, setAnimatingClose] = useState(false)
  const [prevOpen, setPrevOpen] = useState(open)

  if (prevOpen !== open) {
    setPrevOpen(open)
    if (!open) {
      setAnimatingClose(true)
    } else {
      setAnimatingClose(false)
    }
  }

  const shouldRender = open || animatingClose

  useLayoutMotion(inner, '.card-grid > [data-drag-id], .card-grid > [data-motion-id]', { skipInitialFade: true })

  useLayoutEffect(() => {
    const node = outer.current!
    const content = inner.current!

    const update = () => {
      const contentHeight = content.getBoundingClientRect().height
      const targetHeight = open ? contentHeight : 0

      if (!isMounted.current) {
        isMounted.current = true
        height.current = targetHeight
        if (!open) {
          node.style.height = '0px'
          node.style.overflow = 'clip'
        }
        return
      }

      if (height.current === targetHeight && (!open || Math.abs((animation.current ? node.getBoundingClientRect().height : targetHeight) - targetHeight) < .5)) return

      const from = animation.current?.playState === 'running'
        ? node.getBoundingClientRect().height
        : (height.current ?? (open ? 0 : contentHeight))

      animation.current?.cancel()
      height.current = targetHeight

      if (reducedMotion() || Math.abs(from - targetHeight) <= .5) {
        node.style.willChange = ''
        if (open) {
          node.style.overflow = ''
          node.style.height = ''
        } else {
          node.style.overflow = 'clip'
          node.style.height = '0px'
          setAnimatingClose(false)
        }
        return
      }

      node.style.overflow = 'clip'
      node.style.willChange = 'height'
      const current = node.animate([{ height: `${from}px` }, { height: `${targetHeight}px` }], { duration: 240, easing: motionEase, fill: 'forwards' })
      animation.current = current

      void current.finished.then(() => {
        if (animation.current === current) {
          node.style.willChange = ''
          if (open) {
            node.style.overflow = ''
            node.style.height = ''
            current.cancel()
          } else {
            node.style.overflow = 'clip'
            node.style.height = '0px'
            current.cancel()
            setAnimatingClose(false)
          }
        }
      }).catch(() => {})
    }

    update()
    const observer = new ResizeObserver(() => {
      if (open) update()
    })
    observer.observe(content)
    return () => observer.disconnect()
  })

  useLayoutEffect(() => () => animation.current?.cancel(), [])

  return (
    <div ref={outer}>
      <div ref={inner}>
        {shouldRender && children}
      </div>
    </div>
  )
}
