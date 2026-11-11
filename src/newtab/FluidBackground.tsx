import { useEffect, useRef } from 'react'
import { webgl, type WebGLFluidPrism } from 'fluid-prism'

export default function FluidBackground() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    let effect: WebGLFluidPrism
    try {
      effect = webgl.createFluidPrism({
        canvas, fullscreen: true, zIndex: 0, dpr: 1.25, paintScale: 0.2, lowScale: 0.1,
        backgroundColor: '#f7f8ef', amount: 3.2, multiplier: 6, colorMultiplier: 5,
        rgbShift: 0.65, shade: 1.05, pastelFilm: true,
      })
    } catch {
      canvas.hidden = true
      return
    }
    const visibility = () => { if (document.hidden || canvas.hidden) effect.stop(); else effect.start() }
    const lost = (event: Event) => { event.preventDefault(); effect.stop(); canvas.hidden = true }
    document.addEventListener('visibilitychange', visibility)
    canvas.addEventListener('webglcontextlost', lost)
    visibility()
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('webglcontextlost', lost)
      effect.destroy()
    }
  }, [])
  return <canvas ref={ref} className="fixed inset-0 w-full h-full pointer-events-none z-0" aria-hidden="true" />
}
