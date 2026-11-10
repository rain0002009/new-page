import { useEffect, useRef } from 'react'
import { webgl, type WebGLFluidPrism } from 'fluid-prism'

export default function FluidBackground() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    let effect: WebGLFluidPrism
    const scene = document.createElement('canvas')
    try {
      effect = webgl.createFluidPrism({
        canvas, fullscreen: true, zIndex: 0, dpr: 1.25, paintScale: 0.2, lowScale: 0.1,
        backgroundColor: '#f7f8ef', amount: 3.2, multiplier: 6, colorMultiplier: 5,
        rgbShift: 0.65, shade: 1.05, pastelFilm: true,
        contentRenderer(output, { width, height }) {
          if (scene.width === width && scene.height === height) { output.drawImage(scene, 0, 0); return }
          scene.width = width
          scene.height = height
          const ctx = scene.getContext('2d')!
          ctx.fillStyle = '#f7f8ef'
          ctx.fillRect(0, 0, width, height)
          for (const [x, y, radius, color] of [
            [0.12, 0.18, 0.65, '#c7dfc1'], [0.78, 0.12, 0.6, '#ddd7f0'],
            [0.55, 0.9, 0.6, '#f0dfbb'], [1, 0.7, 0.45, '#c4deda'],
          ] as const) {
            const glow = ctx.createRadialGradient(width * x, height * y, 0, width * x, height * y, width * radius)
            glow.addColorStop(0, color)
            glow.addColorStop(1, `${color}00`)
            ctx.fillStyle = glow
            ctx.fillRect(0, 0, width, height)
          }
          // Fine contours give refraction detail without putting text in the texture.
          for (let i = 0; i < 17; i++) {
            ctx.beginPath()
            ctx.moveTo(-width * 0.1, height * (0.15 + i * 0.045))
            ctx.bezierCurveTo(width * 0.25, -height * 0.12, width * 0.55, height * 1.08, width * 1.1, height * (0.15 + i * 0.045))
            ctx.strokeStyle = i % 3 ? '#ffffff45' : '#8caa811c'
            ctx.lineWidth = i % 3 ? 1 : 1.5
            ctx.stroke()
          }
          output.drawImage(scene, 0, 0)
        },
      })
    } catch {
      canvas.hidden = true
      return
    }
    const visibility = () => { if (document.hidden) effect.stop(); else effect.start() }
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
  return <canvas ref={ref} className="fluid-background" aria-hidden="true" />
}
