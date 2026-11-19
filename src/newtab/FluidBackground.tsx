import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createFluidPrism, type FluidPrism, type FluidPrismOptions, type HTMLSourceStatus } from 'fluid-prism'
import { SidebarIdentity } from './SidebarIdentity'

type EffectProps = Omit<FluidPrismOptions,
  'container' | 'canvas' | 'htmlSource' | 'source' | 'contentRenderer' |
  'fullscreen' | 'autoStart' | 'zIndex' | 'hideCursor' | 'backgroundColor'>

interface FluidSceneProps extends EffectProps {
  children: ReactNode
  enabled: boolean
  contentReady: boolean
}

// README's React wrapper: React owns the scene and canvas; the library manages
// HTML-in-Canvas and restores the same DOM when native rendering is unavailable.
function FluidScene({ children, enabled, contentReady, backend = 'webgl', ...options }: FluidSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<FluidPrism | null>(null)
  const optionsRef = useRef<EffectProps>({})
  const enabledRef = useRef(enabled)
  const pendingRef = useRef<Promise<void>>(Promise.resolve())
  const contentReadyRef = useRef(contentReady)
  const [status, setStatus] = useState<HTMLSourceStatus | 'initializing'>('initializing')
  const [painted, setPainted] = useState(false)

  useLayoutEffect(() => { contentReadyRef.current = contentReady }, [contentReady])

  // Restore the reparented scene before React removes its DOM on unmount.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const content = contentRef.current
    if (!canvas || !content) return
    let disposed = false
    let instance: FluidPrism | null = null
    let handoffFrame = 0
    setPainted(false)
    const paintedContent = () => {
      // ready only confirms backend setup. Native HTML's paint event precedes
      // the library's RAF texture upload and draw. Keep the HTML cover through
      // that frame, and wait for profile data if the first scene was empty.
      if (!contentReadyRef.current || handoffFrame) return
      handoffFrame = requestAnimationFrame(() => {
        handoffFrame = requestAnimationFrame(() => {
          handoffFrame = 0
          if (disposed) return
          setPainted(true)
          canvas.removeEventListener('paint', paintedContent)
        })
      })
    }
    pendingRef.current = pendingRef.current.then(async () => {
      if (disposed) return
      instance = await createFluidPrism({ backend, canvas, htmlSource: content, fullscreen: false, autoStart: false })
      if (disposed) { instance.destroy(); return }
      instance.update(optionsRef.current)
      instanceRef.current = instance
      if (enabledRef.current) instance.start()
      await instance.ready
      if (!disposed) {
        setStatus(instance.htmlSourceStatus)
        if (instance.htmlSourceStatus === 'native') canvas.addEventListener('paint', paintedContent)
        else setPainted(true)
      }
    }).catch(() => {
      instance?.destroy()
      if (!disposed) {
        instanceRef.current = null
        canvas.hidden = true
        setStatus('fallback')
        setPainted(true)
      }
    })
    return () => {
      disposed = true
      cancelAnimationFrame(handoffFrame)
      canvas.removeEventListener('paint', paintedContent)
      instance?.destroy()
      instanceRef.current = null
    }
  }, [backend])

  useEffect(() => {
    const reset = Object.fromEntries(Object.keys(optionsRef.current).map(key => [key, undefined]))
    optionsRef.current = { ...reset, ...options }
    instanceRef.current?.update(optionsRef.current)
  })
  useEffect(() => {
    enabledRef.current = enabled
    if (enabled) instanceRef.current?.start()
    else instanceRef.current?.stop()
  }, [enabled])
  return <div data-html-source-status={status} className="fixed inset-0 z-0 bg-ui-canvas pointer-events-none">
    <div ref={contentRef} data-fluid-scene className="relative z-1 w-full h-full overflow-hidden bg-inherit">{children}</div>
    <canvas key={backend} ref={canvasRef} data-fluid={enabled ? 'active' : 'idle'} className="absolute inset-0 w-full h-full z-0 bg-inherit pointer-events-none" />
    {contentReady && !painted && <div data-fluid-placeholder aria-hidden="true" className="absolute inset-0 z-2 bg-inherit pointer-events-none">{children}</div>}
  </div>
}

interface FluidBackgroundProps {
  fluidEnabled: boolean
  nickname?: string
}

export default function FluidBackground({ fluidEnabled, nickname }: FluidBackgroundProps) {
  return <FluidScene enabled={fluidEnabled} contentReady={nickname !== undefined} pauseOnInteraction={false} dpr={Math.max(3, window.devicePixelRatio || 1)} paintScale={0.2} lowScale={0.1} amount={3.2} multiplier={6} colorMultiplier={5} rgbShift={0.65} shade={1.05} pastelFilm>
    <div className="w-[226px] pt-[34px] px-[20px] [@media(min-width:1700px)]:w-[245px] [@media(min-width:1000.01px)_and_(max-width:1200px)]:w-[205px] [@media(min-width:650.01px)_and_(max-width:1000px)]:w-[190px] [@media(max-width:1200px)]:pt-[28px] [@media(max-width:1200px)]:px-[14px] [@media(max-width:650px)]:w-[69px] [@media(max-width:650px)]:pt-[24px] [@media(max-width:650px)]:px-[9px]">
      {nickname !== undefined && <SidebarIdentity nickname={nickname} />}
    </div>
  </FluidScene>
}
