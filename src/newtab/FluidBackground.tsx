import { useCallback, useEffect, useRef } from 'react'
import { webgl, type WebGLFluidPrism } from 'fluid-prism'

/** Lucide Leaf paths (24×24 viewBox) */
const LEAF_PATHS = [
  'M11 20a10 10 0 0010-10 25.9 25.9 0 00-1.04-7.281 1 1 0 00-1.755-.325C15.833 5.5 13 5.5 9.8 6.1A7 7 0 0011 20',
  'M2 21a5 5 0 012.911-4.544C7.613 15.212 8.351 15.24 11 13',
]

/** Sidebar width at each breakpoint (mirrors the grid-cols in NewTabApp) */
function sidebarMetrics(viewW: number) {
  if (viewW <= 650) return { width: 69, px: 9, pt: 24, iconSize: 36, showText: false }
  if (viewW <= 1000) return { width: 190, px: 14, pt: 28, iconSize: 37, showText: true }
  if (viewW <= 1200) return { width: 205, px: 14, pt: 28, iconSize: 37, showText: true }
  if (viewW < 1700) return { width: 226, px: 20, pt: 34, iconSize: 37, showText: true }
  return { width: 245, px: 20, pt: 34, iconSize: 37, showText: true }
}

function drawLeaf(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const scale = size / 24
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(scale, scale)
  ctx.lineWidth = 1.8
  ctx.strokeStyle = '#657b52'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.fillStyle = 'none'
  for (const d of LEAF_PATHS) {
    const path = new Path2D(d)
    ctx.stroke(path)
  }
  ctx.restore()
}

function drawBrand(ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number) {
  const viewW = width / dpr
  const m = sidebarMetrics(viewW)

  // Icon box dimensions (scaled to canvas pixels)
  const boxW = m.iconSize * dpr
  const boxH = (m.iconSize + 3) * dpr  // slightly taller like the DOM version (40px height for 37px width)
  const leafSize = 22 * dpr
  const brandPl = m.showText ? 9 * dpr : 0 // pl-[9px] only on wide sidebar

  // Position: sidebar padding + brand padding
  const ox = m.showText
    ? (m.px + brandPl) * dpr
    : ((m.width - m.iconSize) / 2) * dpr  // centered in compact sidebar
  const oy = m.pt * dpr

  // --- Glow behind the icon box (canvas-specific enhancement) ---
  const glowCx = ox + boxW / 2
  const glowCy = oy + boxH / 2
  const glowR = boxW * 1.2
  const glow = ctx.createRadialGradient(glowCx, glowCy, 0, glowCx, glowCy, glowR)
  glow.addColorStop(0, 'rgba(180, 210, 140, 0.25)')
  glow.addColorStop(0.5, 'rgba(200, 225, 170, 0.10)')
  glow.addColorStop(1, 'rgba(200, 225, 170, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(ox - glowR, oy - glowR, glowR * 2 + boxW, glowR * 2 + boxH)

  // --- Icon rounded-rect background ---
  const r1 = 12 * dpr
  const r2 = 3 * dpr  // bottom-left is 3px
  drawRoundedRect(ctx, ox, oy, boxW, boxH, [r1, r1, r1, r2])
  const grad = ctx.createLinearGradient(ox, oy, ox + boxW, oy + boxH)
  grad.addColorStop(0, '#f7ffec')
  grad.addColorStop(1, '#d4e4bf')
  ctx.fillStyle = grad
  ctx.fill()

  // Subtle inner highlight on the icon box
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)'
  ctx.lineWidth = 1 * dpr
  drawRoundedRect(ctx, ox + 0.5 * dpr, oy + 0.5 * dpr, boxW - 1 * dpr, boxH - 1 * dpr, [r1, r1, r1, r2])
  ctx.stroke()
  ctx.restore()

  // --- Leaf icon ---
  const leafOx = ox + (boxW - leafSize) / 2
  const leafOy = oy + (boxH - leafSize) / 2
  drawLeaf(ctx, leafOx, leafOy, leafSize)

  if (!m.showText) return

  // --- Text ---
  const textX = ox + boxW + 10 * dpr
  const textY = oy

  // "页墟"
  ctx.fillStyle = '#303b2c'
  ctx.font = `bold ${23 * dpr}px "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.textBaseline = 'top'
  ctx.letterSpacing = `${2 * dpr}px`
  ctx.fillText('页墟', textX, textY + 3 * dpr)

  // "PAGE GARDEN"
  ctx.fillStyle = '#98a18d'
  ctx.font = `500 ${7 * dpr}px "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.letterSpacing = `${2.3 * dpr}px`
  ctx.fillText('PAGE GARDEN', textX, textY + 29 * dpr)

  // Reset letterSpacing
  ctx.letterSpacing = '0px'
}

/** Draw a rounded rectangle with per-corner radii [topLeft, topRight, bottomRight, bottomLeft] */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  radii: [number, number, number, number],
) {
  const [tl, tr, br, bl] = radii
  ctx.beginPath()
  ctx.moveTo(x + tl, y)
  ctx.lineTo(x + w - tr, y)
  ctx.arcTo(x + w, y, x + w, y + tr, tr)
  ctx.lineTo(x + w, y + h - br)
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br)
  ctx.lineTo(x + bl, y + h)
  ctx.arcTo(x, y + h, x, y + h - bl, bl)
  ctx.lineTo(x, y + tl)
  ctx.arcTo(x, y, x + tl, y, tl)
  ctx.closePath()
}

interface FluidBackgroundProps {
  /** Whether the fluid animation loop runs. When false, the canvas draws a static Brand only. */
  fluidEnabled: boolean
}

export default function FluidBackground({ fluidEnabled }: FluidBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const effectRef = useRef<WebGLFluidPrism | null>(null)
  const staticDrawnRef = useRef(false)

  const renderBrand = useCallback((ctx: CanvasRenderingContext2D, size: { width: number; height: number; dpr: number }) => {
    drawBrand(ctx, size.width, size.height, size.dpr)
  }, [])

  // Static canvas fallback when fluid is off
  useEffect(() => {
    if (fluidEnabled) {
      staticDrawnRef.current = false
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return

    function draw() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas!.width = window.innerWidth * dpr
      canvas!.height = window.innerHeight * dpr
      canvas!.style.width = `${window.innerWidth}px`
      canvas!.style.height = `${window.innerHeight}px`
      const ctx = canvas!.getContext('2d')
      if (!ctx) return
      // Fill with the same background as the fluid effect
      ctx.fillStyle = '#f7f8ef'
      ctx.fillRect(0, 0, canvas!.width, canvas!.height)
      drawBrand(ctx, canvas!.width, canvas!.height, dpr)
      staticDrawnRef.current = true
    }

    draw()
    window.addEventListener('resize', draw)
    return () => window.removeEventListener('resize', draw)
  }, [fluidEnabled])

  // Fluid effect when enabled
  useEffect(() => {
    if (!fluidEnabled) return
    const canvas = canvasRef.current!
    let effect: WebGLFluidPrism
    try {
      effect = webgl.createFluidPrism({
        canvas, fullscreen: true, zIndex: 0, dpr: 1.25, paintScale: 0.2, lowScale: 0.1,
        backgroundColor: '#f7f8ef', amount: 3.2, multiplier: 6, colorMultiplier: 5,
        rgbShift: 0.65, shade: 1.05, pastelFilm: true,
        contentRenderer: renderBrand,
      })
    } catch {
      canvas.hidden = true
      return
    }
    effectRef.current = effect
    const visibility = () => { if (document.hidden || canvas.hidden) effect.stop(); else effect.start() }
    const lost = (event: Event) => { event.preventDefault(); effect.stop(); canvas.hidden = true }
    document.addEventListener('visibilitychange', visibility)
    canvas.addEventListener('webglcontextlost', lost)
    visibility()
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('webglcontextlost', lost)
      effect.destroy()
      effectRef.current = null
    }
  }, [fluidEnabled, renderBrand])

  return <canvas ref={canvasRef} data-fluid={fluidEnabled ? 'active' : 'idle'} className="fixed inset-0 w-full h-full pointer-events-none z-0" aria-hidden="true" />
}
