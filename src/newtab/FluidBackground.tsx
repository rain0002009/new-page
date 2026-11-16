import { useCallback, useEffect, useRef, useState } from 'react'
import { webgl, type WebGLFluidPrism } from 'fluid-prism'

/** Lucide Leaf paths (24×24 viewBox) */
const LEAF_PATHS = [
  'M11 20a10 10 0 0010-10 25.9 25.9 0 00-1.04-7.281 1 1 0 00-1.755-.325C15.833 5.5 13 5.5 9.8 6.1A7 7 0 0011 20',
  'M2 21a5 5 0 012.911-4.544C7.613 15.212 8.351 15.24 11 13',
]

/** Sidebar width and padding at each breakpoint (mirrors the grid-cols in NewTabApp) */
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
  const boxH = (m.iconSize + 3) * dpr // slightly taller like DOM version (40px height for 37px width)
  const leafSize = 22 * dpr
  const brandPl = m.showText ? 9 * dpr : 0 // pl-[9px] only on wide sidebar

  // Position: sidebar padding + brand padding
  const ox = m.showText
    ? (m.px + brandPl) * dpr
    : ((m.width - m.iconSize) / 2) * dpr // centered in compact sidebar
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
  const r2 = 3 * dpr // bottom-left is 3px
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
  ctx.save()
  ctx.fillStyle = '#303b2c'
  ctx.font = `bold ${23 * dpr}px "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.letterSpacing = `${2 * dpr}px`
  ctx.fillText('页墟', textX, textY + 3 * dpr)

  // "PAGE GARDEN"
  ctx.fillStyle = '#98a18d'
  ctx.font = `500 ${7 * dpr}px "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.letterSpacing = `${2.3 * dpr}px`
  ctx.fillText('PAGE GARDEN', textX, textY + 29 * dpr)
  ctx.restore()
}

function drawProfile(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  nickname: string,
) {
  if (!nickname) return
  const viewW = width / dpr
  // Profile is hidden on compact screens (<= 650px)
  if (viewW <= 650) return

  const m = sidebarMetrics(viewW)
  const brandH = 40
  const brandMb = viewW > 1200 ? 30 : 28
  const profileY = (m.pt + brandH + brandMb) * dpr
  const profileX = (m.px + 10) * dpr

  const avatarSize = 36 * dpr
  const avatarCx = profileX + avatarSize / 2
  const avatarCy = profileY + avatarSize / 2
  const avatarR = avatarSize / 2

  // --- Glow behind avatar (canvas enhancement) ---
  const glowR = avatarSize * 1.15
  const glow = ctx.createRadialGradient(avatarCx, avatarCy, 0, avatarCx, avatarCy, glowR)
  glow.addColorStop(0, 'rgba(180, 210, 140, 0.22)')
  glow.addColorStop(0.6, 'rgba(200, 225, 170, 0.08)')
  glow.addColorStop(1, 'rgba(200, 225, 170, 0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(avatarCx, avatarCy, glowR, 0, Math.PI * 2)
  ctx.fill()

  // --- Avatar circle with 135deg gradient ---
  ctx.save()
  const grad = ctx.createLinearGradient(
    profileX,
    profileY,
    profileX + avatarSize,
    profileY + avatarSize,
  )
  grad.addColorStop(0, '#faffef')
  grad.addColorStop(1, '#d9e6c8')
  ctx.beginPath()
  ctx.arc(avatarCx, avatarCy, avatarR, 0, Math.PI * 2)
  ctx.fillStyle = grad
  ctx.fill()

  // 3px white border (#fafbf5)
  ctx.strokeStyle = '#fafbf5'
  ctx.lineWidth = 3 * dpr
  ctx.stroke()
  ctx.restore()

  // --- Avatar initial text ---
  const initial = nickname.slice(0, 1)
  ctx.save()
  ctx.fillStyle = '#6e7c5e'
  ctx.font = `650 ${15 * dpr}px "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(initial, avatarCx, avatarCy + 0.5 * dpr)
  ctx.restore()

  // --- User Name / Nickname ---
  const textX = profileX + avatarSize + 11 * dpr
  ctx.save()
  ctx.fillStyle = '#303b2c'
  ctx.font = `600 ${13 * dpr}px "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.letterSpacing = '0px'
  ctx.fillText(nickname, textX, avatarCy)
  ctx.restore()
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  nickname: string,
) {
  // 1. Fill base scene background with #f7f8ef
  ctx.fillStyle = '#f7f8ef'
  ctx.fillRect(0, 0, width, height)

  // 2. Draw Brand (Leaf icon + "页墟" + "PAGE GARDEN")
  drawBrand(ctx, width, height, dpr)

  // 3. Draw Profile (Avatar + User Name)
  drawProfile(ctx, width, height, dpr, nickname)
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

function StaticCanvas({ nickname }: { nickname: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function draw() {
      if (!canvas) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      drawScene(ctx, canvas.width, canvas.height, dpr, nickname)
    }

    draw()
    window.addEventListener('resize', draw)
    return () => window.removeEventListener('resize', draw)
  }, [nickname])

  return (
    <canvas
      ref={canvasRef}
      data-fluid="idle"
      className="fixed inset-0 w-full h-full pointer-events-none z-0"
      aria-hidden="true"
    />
  )
}

function FluidCanvas({ nickname }: { nickname: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [webglFailed, setWebglFailed] = useState(false)
  const nicknameRef = useRef(nickname)
  nicknameRef.current = nickname

  const renderScene = useCallback(
    (ctx: CanvasRenderingContext2D, size: { width: number; height: number; dpr: number }) => {
      drawScene(ctx, size.width, size.height, size.dpr, nicknameRef.current)
    },
    [],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let effect: WebGLFluidPrism
    try {
      effect = webgl.createFluidPrism({
        canvas,
        fullscreen: true,
        zIndex: 0,
        dpr: 1.25,
        paintScale: 0.2,
        lowScale: 0.1,
        backgroundColor: '#f7f8ef',
        amount: 3.2,
        multiplier: 6,
        colorMultiplier: 5,
        rgbShift: 0.65,
        shade: 1.05,
        pastelFilm: true,
        contentRenderer: renderScene,
      })
    } catch {
      setWebglFailed(true)
      return
    }

    const visibility = () => {
      if (document.hidden || canvas.hidden) effect.stop()
      else effect.start()
    }
    const lost = (event: Event) => {
      event.preventDefault()
      effect.stop()
      setWebglFailed(true)
    }
    document.addEventListener('visibilitychange', visibility)
    canvas.addEventListener('webglcontextlost', lost)
    visibility()
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('webglcontextlost', lost)
      effect.destroy()
    }
  }, [renderScene])

  if (webglFailed) {
    return <StaticCanvas nickname={nickname} />
  }

  return (
    <canvas
      ref={canvasRef}
      data-fluid="active"
      className="fixed inset-0 w-full h-full pointer-events-none z-0"
      aria-hidden="true"
    />
  )
}

interface FluidBackgroundProps {
  /** Whether the fluid animation loop runs. When false, the canvas draws statically. */
  fluidEnabled: boolean
  nickname?: string
}

export default function FluidBackground({ fluidEnabled, nickname = '' }: FluidBackgroundProps) {
  if (!fluidEnabled) {
    return <StaticCanvas nickname={nickname} />
  }
  return <FluidCanvas nickname={nickname} />
}
