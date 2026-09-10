// 手写批注层：透明 canvas 覆盖在题目之上
//
// 三层画布思路：
//   底层 canvas   已提交的笔画
//   顶层 canvas   正在画的那一笔 / 框选矩形 / 选中框 / 拖动预览  —— 不吃指针事件
//   事件全由底层 canvas 处理，所以实时反馈完全不经过 React state，不卡。
//
// 其它要点：
//   - 笔画以矢量形式存储，缩放 / DPR 变化时全量重绘，永不丢内容
//   - 橡皮是「笔画橡皮」：命中整条删除，这样擦除才能进撤销栈
//   - 框选变换在拖动开始时把选中笔画从底层抹掉，只在顶层预览，
//     松手才提交（一次完整重绘），所以拖动过程中不会出现重影
import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { STAGE_H, STAGE_W, type Point, type Stroke } from './types'

/** 橡皮命中判定的额外容差（逻辑 px） */
const ERASER_SLOP = 8
/** 单帧最多删除的笔画数，防止大面积擦除时卡顿 */
const MAX_ERASE_PER_FRAME = 200
/** 手掌误触抑制：笔事件之后这段时间内的 touch 事件一律忽略 */
const PALM_GUARD_MS = 1500
/**
 * 位图宽度上限。4K 屏 + DPR2 时 1600×scale×dpr 会到 7000+ px（约 120MB 显存），
 * 低配教室电脑有崩的风险。4096 相当于 2.56 倍超采样，清晰度完全够用。
 */
const MAX_BITMAP_W = 4096
/** 选中框角点手柄的边长（逻辑 px） */
const HANDLE = 22
/** 框选的最小尺寸，小于它视为「点空白 = 取消选择」 */
const MIN_MARQUEE = 6

export type BoardTool = 'pen' | 'highlighter' | 'eraser' | 'select' | 'pan' | 'none'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Props {
  /** 舞台缩放系数 k，用于计算 canvas 位图分辨率 */
  scale: number
  tool: BoardTool
  color: string
  size: number
  strokes: Stroke[]
  onCommit: (stroke: Stroke) => void
  onErase: (ids: string[]) => void
  /** 框选后移动 / 缩放：提交前后两组笔画（一次可撤销动作） */
  onTransform?: (before: Stroke[], after: Stroke[]) => void
  /** 平移：参数是屏幕像素位移 */
  onPan?: (dx: number, dy: number) => void
  /** 选中集合变化（供工具栏显示「删除选中」等） */
  onSelectionChange?: (ids: string[]) => void
  /**
   * 纵向偏移（逻辑 px）。解析面板长高时，题目层与批注层要同步上移，
   * 二者位移一致才能保证板书始终贴在题目上。
   */
  offsetY?: number
  onContextMenu?: (e: React.MouseEvent) => void
}

let strokeSeq = 0
function newStrokeId(): string {
  strokeSeq += 1
  return `s${Date.now().toString(36)}${strokeSeq.toString(36)}`
}

/** 点到线段的距离平方 */
function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + t * dx
  const cy = ay + t * dy
  const ex = px - cx
  const ey = py - cy
  return ex * ex + ey * ey
}

/** 两条线段是否相交 */
function segIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x)
  if (Math.abs(d) < 1e-9) return false
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d
  const u = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

/** 笔画是否与矩形相交（「碰到就算」） */
function strokeHitsRect(s: Stroke, r: Rect, pad: number): boolean {
  const rr: Rect = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }
  const pts = s.points
  if (pts.length === 0) return false
  for (const p of pts) if (pointInRect(p, rr)) return true
  // 整条线跨过矩形但端点都在外面：检查与四条边的交点
  const corners: Point[] = [
    { x: rr.x, y: rr.y, p: 1 },
    { x: rr.x + rr.w, y: rr.y, p: 1 },
    { x: rr.x + rr.w, y: rr.y + rr.h, p: 1 },
    { x: rr.x, y: rr.y + rr.h, p: 1 },
  ]
  for (let i = 1; i < pts.length; i++) {
    for (let k = 0; k < 4; k++) {
      if (segIntersect(pts[i - 1], pts[i], corners[k], corners[(k + 1) % 4])) return true
    }
  }
  return false
}

/** 一组笔画的包围盒 */
export function strokesBounds(list: Stroke[]): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of list) {
    const half = (s.tool === 'highlighter' ? s.width * 3 : s.width) / 2 + 2
    for (const p of s.points) {
      if (p.x - half < minX) minX = p.x - half
      if (p.y - half < minY) minY = p.y - half
      if (p.x + half > maxX) maxX = p.x + half
      if (p.y + half > maxY) maxY = p.y + half
    }
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

/** 选中框四角手柄的位置 */
function handleRects(b: Rect): Rect[] {
  return [
    { x: b.x - HANDLE / 2, y: b.y - HANDLE / 2, w: HANDLE, h: HANDLE },
    { x: b.x + b.w - HANDLE / 2, y: b.y - HANDLE / 2, w: HANDLE, h: HANDLE },
    { x: b.x + b.w - HANDLE / 2, y: b.y + b.h - HANDLE / 2, w: HANDLE, h: HANDLE },
    { x: b.x - HANDLE / 2, y: b.y + b.h - HANDLE / 2, w: HANDLE, h: HANDLE },
  ]
}

/** 把一组笔画按给定变换生成新笔画（缩放 + 平移） */
function transformStrokes(list: Stroke[], sx: number, sy: number, ox: number, oy: number, scaleW: number): Stroke[] {
  return list.map(s => ({
    ...s,
    width: Math.max(0.5, s.width * scaleW),
    points: s.points.map(p => ({ x: p.x * sx + ox, y: p.y * sy + oy, p: p.p })),
  }))
}

/**
 * 画一条笔画（逻辑坐标）。
 *
 * ⚠️ 这里必须对整条笔画只调用一次 stroke() / fill()：
 * 半透明的荧光笔若按「每段一次 stroke」绘制，段与段在拐点处会叠加出深色圆点。
 * 同一条路径只 stroke 一次时，重叠区域只合成一次，颜色才是均匀的。
 * 代价是荧光笔不能用逐段变化的压感宽度 —— 真实荧光笔本来就是平头等宽的。
 */
export function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const pts = stroke.points
  if (pts.length === 0) return
  const isHighlighter = stroke.tool === 'highlighter'

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = stroke.color
  ctx.fillStyle = stroke.color
  if (isHighlighter) ctx.globalAlpha = 0.35

  if (pts.length === 1) {
    const p = pts[0]
    const w = isHighlighter ? stroke.width * 3 : stroke.width * (0.55 + 0.9 * p.p)
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(0.5, w / 2), 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    return
  }

  if (isHighlighter) {
    ctx.lineWidth = stroke.width * 3
    strokeSmoothPath(ctx, pts)
    ctx.stroke()
    ctx.restore()
    return
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const pressure = (a.p + b.p) / 2
    ctx.beginPath()
    ctx.lineWidth = Math.max(0.4, stroke.width * (0.55 + 0.9 * pressure))
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  ctx.restore()
}

/** 用中点二次贝塞尔把折线画成平滑曲线 */
function strokeSmoothPath(ctx: CanvasRenderingContext2D, pts: Point[]): void {
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last.x, last.y)
}

/** 全量重绘一页的所有笔画 */
export function paintAll(ctx: CanvasRenderingContext2D, strokes: Stroke[]): void {
  ctx.clearRect(0, 0, STAGE_W, STAGE_H)
  for (const s of strokes) paintStroke(ctx, s)
}

/** 画框选矩形 / 选中框 / 手柄 */
function paintSelectionChrome(
  ctx: CanvasRenderingContext2D,
  marquee: Rect | null,
  bounds: Rect | null,
): void {
  ctx.save()
  if (marquee) {
    ctx.fillStyle = 'rgba(83, 74, 183, 0.12)'
    ctx.fillRect(marquee.x, marquee.y, marquee.w, marquee.h)
    ctx.strokeStyle = '#534ab7'
    ctx.lineWidth = 2
    ctx.setLineDash([8, 6])
    ctx.strokeRect(marquee.x, marquee.y, marquee.w, marquee.h)
    ctx.setLineDash([])
  }
  if (bounds) {
    ctx.strokeStyle = '#534ab7'
    ctx.lineWidth = 2
    ctx.setLineDash([10, 6])
    ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h)
    ctx.setLineDash([])
    for (const h of handleRects(bounds)) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(h.x, h.y, h.w, h.h)
      ctx.strokeStyle = '#534ab7'
      ctx.lineWidth = 2
      ctx.strokeRect(h.x, h.y, h.w, h.h)
    }
  }
  ctx.restore()
}

type SelDrag =
  | null
  | { mode: 'move'; startX: number; startY: number; orig: Stroke[]; bounds: Rect }
  | { mode: 'scale'; corner: number; orig: Stroke[]; bounds: Rect }

export default function AnnotationCanvas({
  scale,
  tool,
  color,
  size,
  strokes,
  onCommit,
  onErase,
  onTransform,
  onPan,
  onSelectionChange,
  offsetY = 0,
  onContextMenu,
}: Props) {
  // 两层画布：底层放已提交的笔画，顶层只放正在画的那一笔 / 框选装饰
  const localRef = useRef<HTMLCanvasElement>(null)
  const liveRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const liveCtxRef = useRef<CanvasRenderingContext2D | null>(null)

  const drawingRef = useRef(false)
  const activePointerRef = useRef<number | null>(null)
  const currentRef = useRef<Stroke | null>(null)
  const lastPenTimeRef = useRef(0)
  const lastEraseFrameRef = useRef(0)

  // 框选 / 变换（全部走 ref，拖动过程不触发 React 重渲染）
  const marqueeRef = useRef<Rect | null>(null)
  const marqueeOriginRef = useRef<Point | null>(null)
  const selectionRef = useRef<string[]>([])
  const selBoundsRef = useRef<Rect | null>(null)
  const selDragRef = useRef<SelDrag>(null)
  const selPreviewRef = useRef<Stroke[] | null>(null)

  // 平移
  const panRef = useRef<{ x: number; y: number } | null>(null)

  // 最新 props 的镜像：事件回调里读它，避免因闭包过期拿到旧值
  const strokeMapRef = useRef<Map<string, Stroke>>(new Map())
  useEffect(() => {
    const m = new Map<string, Stroke>()
    for (const s of strokes) m.set(s.id, s)
    strokeMapRef.current = m
  }, [strokes])

  /** 只重绘顶层 */
  const paintLive = useCallback(() => {
    const ctx = liveCtxRef.current
    if (!ctx) return
    ctx.clearRect(0, 0, STAGE_W, STAGE_H)
    const preview = selPreviewRef.current
    if (preview) for (const s of preview) paintStroke(ctx, s)
    const cur = currentRef.current
    if (cur) paintStroke(ctx, cur)
    paintSelectionChrome(ctx, marqueeRef.current, selBoundsRef.current)
  }, [])

  /** 把底层重绘成「去掉选中笔画」的样子，拖动期间不会出现重影 */
  const paintBaseWithoutSelection = useCallback(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    const sel = new Set(selectionRef.current)
    paintAll(ctx, strokes.filter(s => !sel.has(s.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes])

  const clearSelection = useCallback(() => {
    selectionRef.current = []
    selBoundsRef.current = null
    selPreviewRef.current = null
    selDragRef.current = null
    onSelectionChange?.([])
    paintLive()
  }, [paintLive, onSelectionChange])

  /** 按当前 scale 与 DPR 重建两层位图 */
  const resizeBitmap = useCallback(() => {
    const main = localRef.current
    const live = liveRef.current
    if (!main || !live) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let px = Math.max(0.1, scale * dpr)
    if (STAGE_W * px > MAX_BITMAP_W) px = MAX_BITMAP_W / STAGE_W
    const w = Math.round(STAGE_W * px)
    const h = Math.round(STAGE_H * px)

    for (const c of [main, live]) {
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      c.style.width = `${STAGE_W}px`
      c.style.height = `${STAGE_H}px`
    }

    const mainCtx = main.getContext('2d')
    if (mainCtx) {
      mainCtx.setTransform(px, 0, 0, px, 0, 0)
      ctxRef.current = mainCtx
      paintAll(mainCtx, strokes)
    }
    const liveCtx = live.getContext('2d')
    if (liveCtx) {
      liveCtx.setTransform(px, 0, 0, px, 0, 0)
      liveCtxRef.current = liveCtx
      paintLive()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, paintLive])

  useLayoutEffect(() => {
    resizeBitmap()
  }, [resizeBitmap])

  // 笔画变化（提交/撤销/重做/擦除/翻页）时重绘底层
  useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    paintAll(ctx, strokes)
  }, [strokes])

  // 换工具时清掉选区，避免残影
  useEffect(() => {
    if (tool !== 'select') clearSelection()
  }, [tool, clearSelection])

  // 窗口尺寸/DPR 变化（插拔投影仪、Ctrl+滚轮缩放）时重建位图
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => resizeBitmap())
    }
    window.addEventListener('resize', onResize)
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    mq.addEventListener?.('change', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      mq.removeEventListener?.('change', onResize)
    }
  }, [resizeBitmap])

  /** 客户端坐标 -> 白板逻辑坐标（自动处理舞台缩放与纵向偏移） */
  const toLogical = useCallback((clientX: number, clientY: number): Point | null => {
    const canvas = localRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: ((clientX - rect.left) / rect.width) * STAGE_W,
      y: ((clientY - rect.top) / rect.height) * STAGE_H,
      p: 1,
    }
  }, [])

  const readPressure = (e: React.PointerEvent): number => {
    if (e.pointerType === 'pen' && e.pressure > 0) return Math.min(1, Math.max(0.05, e.pressure))
    return 1
  }

  /** 橡皮：命中测试并上报要删除的笔画 id */
  const eraseAt = useCallback((pt: Point, width: number) => {
    const now = performance.now()
    if (now - lastEraseFrameRef.current < 16) return
    lastEraseFrameRef.current = now
    const radius = width / 2 + ERASER_SLOP
    const rSq = radius * radius
    const hit: string[] = []
    for (const s of strokes) {
      if (hit.length >= MAX_ERASE_PER_FRAME) break
      const half = (s.tool === 'highlighter' ? s.width * 3 : s.width) / 2 + ERASER_SLOP
      const rr = Math.max(rSq, half * half)
      const pts = s.points
      if (pts.length === 1) {
        const dx = pts[0].x - pt.x
        const dy = pts[0].y - pt.y
        if (dx * dx + dy * dy <= rr) hit.push(s.id)
        continue
      }
      for (let i = 1; i < pts.length; i++) {
        if (distToSegmentSq(pt.x, pt.y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= rr) {
          hit.push(s.id)
          break
        }
      }
    }
    if (hit.length > 0) onErase(hit)
  }, [strokes, onErase])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'pen') lastPenTimeRef.current = Date.now()
    // 手掌误触：刚用笔写过，紧接着的触摸事件忽略
    if (e.pointerType === 'touch' && Date.now() - lastPenTimeRef.current < PALM_GUARD_MS) return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (tool === 'none') return

    const pt = toLogical(e.clientX, e.clientY)
    if (!pt) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    activePointerRef.current = e.pointerId

    if (tool === 'pan') {
      panRef.current = { x: e.clientX, y: e.clientY }
      drawingRef.current = true
      return
    }

    if (tool === 'select') {
      const bounds = selBoundsRef.current
      if (bounds) {
        // 先看是不是按在角点手柄上
        const hs = handleRects(bounds)
        const corner = hs.findIndex(h => pointInRect(pt, h))
        const sel = selectionRef.current
        const orig = sel.map(id => strokeMapRef.current.get(id)).filter(Boolean) as Stroke[]
        if (orig.length > 0) {
          if (corner >= 0) {
            selDragRef.current = { mode: 'scale', corner, orig, bounds }
            // 底层抹掉原件，只在顶层预览，避免拖动时重影
            paintBaseWithoutSelection()
            drawingRef.current = true
            return
          }
          if (pointInRect(pt, bounds)) {
            selDragRef.current = { mode: 'move', startX: pt.x, startY: pt.y, orig, bounds }
            paintBaseWithoutSelection()
            drawingRef.current = true
            return
          }
        }
      }
      // 否则开始新的框选
      clearSelection()
      marqueeOriginRef.current = { x: pt.x, y: pt.y, p: 1 }
      marqueeRef.current = { x: pt.x, y: pt.y, w: 0, h: 0 }
      drawingRef.current = true
      paintLive()
      return
    }

    if (tool === 'eraser') {
      drawingRef.current = true
      eraseAt(pt, size)
      return
    }

    pt.p = readPressure(e)
    const stroke: Stroke = {
      id: newStrokeId(),
      tool: tool === 'highlighter' ? 'highlighter' : 'pen',
      color,
      width: size,
      points: [pt],
      createdAt: Date.now(),
    }
    currentRef.current = stroke
    drawingRef.current = true
    paintLive()
  }, [toLogical, tool, size, color, eraseAt, paintLive, clearSelection, paintBaseWithoutSelection])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'pen') lastPenTimeRef.current = Date.now()
    if (!drawingRef.current) return
    if (activePointerRef.current !== e.pointerId) return
    if (e.pointerType === 'touch' && Date.now() - lastPenTimeRef.current < PALM_GUARD_MS) return

    const pt = toLogical(e.clientX, e.clientY)
    if (!pt) return
    e.preventDefault()

    if (tool === 'pan') {
      const p = panRef.current
      if (!p) return
      onPan?.(e.clientX - p.x, e.clientY - p.y)
      return
    }

    if (tool === 'select') {
      const drag = selDragRef.current
      if (drag?.mode === 'move') {
        const ox = pt.x - drag.startX
        const oy = pt.y - drag.startY
        selPreviewRef.current = transformStrokes(drag.orig, 1, 1, ox, oy, 1)
        selBoundsRef.current = {
          ...drag.bounds,
          x: drag.bounds.x + ox,
          y: drag.bounds.y + oy,
        }
        paintLive()
        return
      }
      if (drag?.mode === 'scale') {
        const b = drag.bounds
        // 对角手柄作为锚点，拖动的那个手柄决定缩放倍数
        const anchorX = drag.corner === 0 || drag.corner === 3 ? b.x + b.w : b.x
        const anchorY = drag.corner === 0 || drag.corner === 1 ? b.y + b.h : b.y
        const sx = Math.abs(pt.x - anchorX) / Math.max(1, b.w)
        const sy = Math.abs(pt.y - anchorY) / Math.max(1, b.h)
        // 等比缩放（取两轴较小值），避免板书被拉变形
        const s = Math.max(0.05, Math.min(sx, sy))
        selPreviewRef.current = drag.orig.map(st => ({
          ...st,
          width: Math.max(0.5, st.width * s),
          points: st.points.map(p => ({
            x: anchorX + (p.x - anchorX) * s,
            y: anchorY + (p.y - anchorY) * s,
            p: p.p,
          })),
        }))
        selBoundsRef.current = {
          x: Math.min(anchorX, anchorX + (b.x - anchorX) * s),
          y: Math.min(anchorY, anchorY + (b.y - anchorY) * s),
          w: b.w * s,
          h: b.h * s,
        }
        paintLive()
        return
      }
      // 框选矩形：以按下点为原点，用两个对角点算规范化矩形
      const o = marqueeOriginRef.current
      if (o) {
        marqueeRef.current = {
          x: Math.min(o.x, pt.x),
          y: Math.min(o.y, pt.y),
          w: Math.abs(pt.x - o.x),
          h: Math.abs(pt.y - o.y),
        }
        paintLive()
      }
      return
    }

    if (tool === 'eraser') {
      eraseAt(pt, size)
      return
    }

    const stroke = currentRef.current
    if (!stroke) return
    pt.p = readPressure(e)
    const prev = stroke.points[stroke.points.length - 1]
    const dx = pt.x - prev.x
    const dy = pt.y - prev.y
    if (dx * dx + dy * dy < 0.25) return
    stroke.points.push(pt)
    paintLive()
  }, [toLogical, tool, size, eraseAt, paintLive, onPan])

  const finishStroke = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== e.pointerId) return
    activePointerRef.current = null
    if (!drawingRef.current) {
      panRef.current = null
      return
    }
    drawingRef.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 已释放 */
    }

    if (tool === 'pan') {
      panRef.current = null
      return
    }

    if (tool === 'select') {
      // 拖动变换：提交
      const drag = selDragRef.current
      if (drag && selPreviewRef.current) {
        const after = selPreviewRef.current
        selDragRef.current = null
        selPreviewRef.current = null
        onTransform?.(drag.orig, after)
        // 提交后由 props.strokes 变化触发底层重绘；这里只清顶层
        paintLive()
        return
      }
      selDragRef.current = null
      // 框选结束：算出命中的笔画
      const m = marqueeRef.current
      marqueeRef.current = null
      marqueeOriginRef.current = null
      if (m && m.w > MIN_MARQUEE && m.h > MIN_MARQUEE) {
        const hit: string[] = []
        for (const s of strokes) {
          const half = (s.tool === 'highlighter' ? s.width * 3 : s.width) / 2
          if (strokeHitsRect(s, m, half)) hit.push(s.id)
        }
        const sel = hit.map(id => strokeMapRef.current.get(id)).filter(Boolean) as Stroke[]
        selectionRef.current = hit
        selBoundsRef.current = strokesBounds(sel)
        onSelectionChange?.(hit)
      }
      paintLive()
      return
    }

    const stroke = currentRef.current
    currentRef.current = null
    paintLive()
    if (!stroke || stroke.points.length === 0) return
    onCommit(stroke)
  }, [onCommit, paintLive, tool, strokes, onTransform, onSelectionChange])

  const cursor =
    tool === 'eraser' ? 'cell'
    : tool === 'pan' ? 'grab'
    : tool === 'select' ? 'default'
    : tool === 'none' ? 'default'
    : 'crosshair'

  // 解析面板长高时，批注层跟着上移，同时把「属于解析区域」的笔迹裁掉。
  // 不裁的话这些笔迹会浮在重排后的解析文字上，位置对不上。
  // 系数 0.8 让裁切与展开同步：完全展开（offsetY=500）时恰好只剩题目区（0~500）内的笔迹。
  const shift = offsetY
    ? {
        transform: `translateY(${-offsetY}px)`,
        clipPath: `inset(0 0 ${0.8 * offsetY}px 0)`,
      }
    : undefined

  return (
    <>
      <canvas
        ref={localRef}
        className="wb-canvas"
        style={{ cursor, ...shift }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onContextMenu={onContextMenu}
      />
      {/* 实时预览层：不吃事件，只显示正在画的那一笔与框选装饰 */}
      <canvas ref={liveRef} className="wb-canvas wb-canvas-live" style={shift} />
    </>
  )
}
