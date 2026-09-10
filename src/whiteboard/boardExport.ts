// 导出白板页面
// 关键点：绝不直接对带 transform:scale(k) 的舞台调用 html2canvas —— 1.4.1 对 transform 祖先
// 支持很差，会错位/裁切。正确做法是克隆一份到屏幕外、复位 transform，再手动把批注层叠上去。
import { paintAll } from './AnnotationCanvas'
import { ANSWER_PANEL_H, STAGE_H, STAGE_W, type Stroke } from './types'

/** 导出分辨率倍数：1600×900 逻辑版面 × 2 = 3200×1800 */
const EXPORT_SCALE = 2

/** 题目区高度：解析面板从这条线往下开始 */
const QUESTION_H = STAGE_H - ANSWER_PANEL_H

export interface ExportPageInput {
  /** 题目层 + 答案层所在的容器（1600×900） */
  stage: HTMLElement
  /** 该页的笔画（用于按导出分辨率重绘，避免小窗口下被放大变糊） */
  strokes: Stroke[]
  title: string
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 统计克隆里未加载完成的图片数量（用于导出前提示） */
function countBrokenImages(root: HTMLElement): number {
  let n = 0
  root.querySelectorAll('img').forEach(img => {
    if (!img.complete || img.naturalWidth === 0) n += 1
  })
  return n
}

/**
 * 按导出分辨率重新绘制批注层。
 * 不直接复用屏幕上那块 canvas：小窗口下它的位图分辨率可能只有 1600 宽，
 * 直接拉伸到 3200 会发虚。这里新建一张按需分辨率的画布重绘。
 */
function renderAnnotationAt(strokes: Stroke[], pixelWidth: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = pixelWidth
  c.height = Math.round(pixelWidth * (STAGE_H / STAGE_W))
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('无法创建批注层画布')
  ctx.setTransform(pixelWidth / STAGE_W, 0, 0, pixelWidth / STAGE_W, 0, 0)
  paintAll(ctx, strokes)
  return c
}

/**
 * cloneNode 不会复制滚动位置。解析面板滚到一半时导出，
 * 克隆体会回到顶部，导出的图和屏幕看到的对不上。这里把滚动位置一并搬过去。
 */
function syncScrollPositions(src: HTMLElement, dst: HTMLElement): void {
  const srcAll = src.querySelectorAll('*')
  const dstAll = dst.querySelectorAll('*')
  const n = Math.min(srcAll.length, dstAll.length)
  for (let i = 0; i < n; i++) {
    const s = srcAll[i] as HTMLElement
    if (s.scrollTop || s.scrollLeft) {
      const d = dstAll[i] as HTMLElement
      d.scrollTop = s.scrollTop
      d.scrollLeft = s.scrollLeft
    }
  }
}

/**
 * 导出时把解析面板展开到完整高度，让「没滚到的那部分」也能进图。
 *
 * 屏幕上面板固定 400px 高、正文内部滚动；这里把正文的滚动约束去掉，
 * 面板改为从题目区下方（QUESTION_H）开始按内容自然撑高，再把克隆体整体加高。
 * 返回导出所需的逻辑高度（无解析或解析不长时就是 STAGE_H）。
 */
function expandAnswerForExport(clone: HTMLElement): number {
  const panel = clone.querySelector('.wb-answer-panel') as HTMLElement | null
  const body = clone.querySelector('.wb-answer-body') as HTMLElement | null
  if (!panel || !body) return STAGE_H

  body.style.overflow = 'visible'
  body.style.maxHeight = 'none'
  body.style.height = 'auto'
  body.style.flex = '0 0 auto'

  panel.style.top = `${QUESTION_H}px`
  panel.style.bottom = 'auto'
  panel.style.height = 'auto'

  // 读 offsetHeight 会强制回流，拿到的是完整解析的高度
  const total = QUESTION_H + panel.offsetHeight
  if (total <= STAGE_H) {
    // 解析不长，保持 1600×900 原版面
    panel.style.top = ''
    panel.style.bottom = ''
    panel.style.height = ''
    return STAGE_H
  }
  clone.style.height = `${total}px`
  return total
}

/**
 * 合成一页为 canvas：题目层（html2canvas）+ 批注层（按导出分辨率重绘后叠加）。
 *
 * ⚠️ 必须在该页正显示在屏幕上时调用 —— stage 是活的 DOM 节点，
 * 先把所有页的信息收集起来再统一渲染，会导致每页都渲染成最后一页的内容。
 */
export async function renderStageToCanvas(input: ExportPageInput): Promise<HTMLCanvasElement> {
  const clone = input.stage.cloneNode(true) as HTMLElement
  // 克隆体放到屏幕外并强制 1:1 尺寸，隔离现场 DOM 的 transform
  clone.style.cssText +=
    `;position:fixed;left:-20000px;top:0;width:${STAGE_W}px;height:${STAGE_H}px;transform:none;margin:0;`
  // 克隆里的 canvas 会被 html2canvas 以不可靠的方式渲染，直接去掉，稍后手动叠加
  clone.querySelectorAll('canvas').forEach(c => c.remove())
  // 滚动条是屏幕上的交互控件，不该出现在导出图里
  clone.querySelectorAll('.wb-scroll-rail').forEach(el => el.remove())
  document.body.appendChild(clone)
  syncScrollPositions(input.stage, clone)

  try {
    const exportH = expandAnswerForExport(clone)

    // MathJax 的 SVG 大量使用 currentColor，html2canvas 1.4.1 对此有 bug，显式上色
    clone.querySelectorAll('mjx-container svg').forEach(svg => {
      svg.setAttribute('fill', '#111827')
      svg.setAttribute('color', '#111827')
      ;(svg as SVGElement).style.color = '#111827'
    })

    const html2canvas = (await import('html2canvas')).default
    const base = await html2canvas(clone, {
      scale: EXPORT_SCALE,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      width: STAGE_W,
      height: exportH,
      windowWidth: STAGE_W,
      windowHeight: exportH,
      imageTimeout: 5000,
    })

    const out = document.createElement('canvas')
    out.width = base.width
    out.height = base.height
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('无法创建导出画布')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(base, 0, 0)

    // 批注层贴在左上角（与题目同比例）。
    // 导出时解析总是展开到完整高度，其排版与屏幕上不同，
    // 所以画在解析区域的笔迹在这里必然对不上号 —— 统一裁到题目区，保证不漏不错。
    const annotation = renderAnnotationAt(input.strokes, out.width)
    const clipToQuestion = clone.querySelector('.wb-answer-panel') !== null
    if (clipToQuestion) {
      const qh = Math.round(out.width * (QUESTION_H / STAGE_W))
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, out.width, Math.min(qh, out.height))
      ctx.clip()
      ctx.drawImage(annotation, 0, 0)
      ctx.restore()
    } else {
      ctx.drawImage(annotation, 0, 0)
    }
    return out
  } finally {
    clone.remove()
  }
}

/** 导出当前页为 PNG */
export async function exportPagePng(input: ExportPageInput): Promise<void> {
  const canvas = await renderStageToCanvas(input)
  await new Promise<void>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) return reject(new Error('导出失败：无法生成图片'))
      downloadBlob(blob, `${sanitize(input.title)}.png`)
      resolve()
    }, 'image/png')
  })
}

/**
 * 导出多页 PDF。
 *
 * 传入的是「渲染第 i 页」的回调而不是现成的页面数据 —— 因为 renderStageToCanvas
 * 依赖屏幕上当前显示的内容，必须「翻到第 i 页 → 立刻渲染 → 再翻下一页」。
 * 若先收集所有页再统一渲染，每页都会变成最后一页的内容。
 *
 * 页宽固定 800pt（对应 1600 逻辑 px），页高按该页内容自适应：
 * 解析长的页会更高，不会被压扁或截断。
 */
export async function exportAllPdf(
  pageCount: number,
  renderPageAt: (index: number) => Promise<HTMLCanvasElement>,
  filename: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (pageCount <= 0) return
  const { jsPDF } = await import('jspdf')
  const PT_W = STAGE_W / 2
  const pageSize = (canvas: HTMLCanvasElement) => {
    const w = PT_W
    const h = (canvas.height / canvas.width) * PT_W
    // jsPDF 会按 orientation 校正长宽顺序，显式给对才不会把页面转 90°
    return { w, h, orientation: h >= w ? ('portrait' as const) : ('landscape' as const) }
  }

  const first = await renderPageAt(0)
  const s0 = pageSize(first)
  const pdf = new jsPDF({ orientation: s0.orientation, unit: 'pt', format: [s0.w, s0.h] })
  pdf.addImage(first.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, s0.w, s0.h)
  onProgress?.(1, pageCount)

  for (let i = 1; i < pageCount; i++) {
    const canvas = await renderPageAt(i)
    const s = pageSize(canvas)
    pdf.addPage([s.w, s.h], s.orientation)
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, s.w, s.h)
    onProgress?.(i + 1, pageCount)
  }
  pdf.save(`${sanitize(filename)}.pdf`)
}

/** 检查一页里是否有加载失败的图片，供 UI 提示 */
export function pageHasBrokenImages(stage: HTMLElement): number {
  return countBrokenImages(stage)
}

function sanitize(name: string): string {
  return (name || '白板').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

