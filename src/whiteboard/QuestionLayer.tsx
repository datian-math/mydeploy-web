// 单页题目层：题干 + 选项 + 答案解析
// 关键约束：内容容器宽度固定 1488 逻辑 px，绝不随窗口变化。
// 超长内容只做 transform:scale 缩小，不改宽度 —— 这样 MathJax 永远不会重排。
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MathJaxPreview } from '../components/MathJaxPreview'
import { ANSWER_PANEL_H, STAGE_H, STAGE_W, type BoardItem } from './types'

const PAD_TOP = 36

const TYPE_LABEL: Record<string, string> = {
  '单选': '单选题',
  '多选': '多选题',
  '填空': '填空题',
  '解答': '解答题',
}

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

interface Props {
  item: BoardItem
  index: number
  total: number
  showAnswer: boolean
  /**
   * 解析面板额外长高的逻辑像素（0 ~ ANSWER_EXPAND_MAX）。
   * 面板从底部往上长，题目层与批注层同步上移同样的距离 ——
   * 二者位移一致，所以板书永远贴在题目上，不会错位；
   * 移出舞台顶部的部分被 .wb-stage 的 overflow:hidden 自然裁掉。
   */
  answerExpand?: number
  /** 本页公式渲染完成后回调（导出 PDF 时用来等待页面就绪） */
  onRendered?: () => void
}

export default function QuestionLayer({
  item,
  index,
  total,
  showAnswer,
  answerExpand = 0,
  onRendered,
}: Props) {
  const clipRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const answerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [availH, setAvailH] = useState(STAGE_H - PAD_TOP)
  const [answerScroll, setAnswerScroll] = useState({ top: 0, height: 0, client: 0 })

  // 题目区可用高度：显示答案时让出底部解析面板
  useLayoutEffect(() => {
    setAvailH(STAGE_H - PAD_TOP - (showAnswer ? ANSWER_PANEL_H : 0))
  }, [showAnswer])

  const remeasure = useCallback(() => {
    const el = measureRef.current
    if (!el) return
    const natural = el.scrollHeight
    if (natural <= 0) return
    // 头部标签占位约 44px，由 clip 容器自身的可用高度决定最终缩放
    const cap = (clipRef.current?.clientHeight ?? availH) - 0
    setScale(natural > cap && cap > 0 ? Math.max(0.35, cap / natural) : 1)
  }, [availH])

  // MathJax 渲染完成：重新测高 + 通知父组件（导出等待用）
  const handlePreviewRendered = useCallback(() => {
    remeasure()
    onRendered?.()
  }, [remeasure, onRendered])

  // 内容自然高度变化时重新计算缩放（MathJax 渲染完成、图片加载完成都会触发）
  useEffect(() => {
    const el = measureRef.current
    if (!el) return
    const ro = new ResizeObserver(() => remeasure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [remeasure])

  // 换题时先复位缩放，避免用上一题的 scale 测量
  useEffect(() => {
    setScale(1)
    const t = window.setTimeout(remeasure, 0)
    return () => window.clearTimeout(t)
  }, [item.pageId, showAnswer, remeasure])

  const imageMap = React.useMemo(() => new Map(Object.entries(item.images || {})), [item.images])

  const answerText = item.analysis || item.answerContent || ''
  const showAnswerPanel = showAnswer && Boolean(answerText || item.answer)

  // ---------- 解析面板滚动 ----------
  // 批注 canvas 铺满整个舞台并盖在解析面板之上，鼠标/触屏事件都到不了面板，
  // 所以原生滚动条既看不见也点不到。这里自己补三条滚动路径：
  //   ① 滚轮转发  ② ↑/↓ 方向键  ③ 画在 canvas 之上的可拖动滚动条（见 AnswerScrollRail）

  const syncAnswerScroll = useCallback(() => {
    const el = answerRef.current
    if (!el) return
    setAnswerScroll(prev => {
      const next = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }
      if (prev.top === next.top && prev.height === next.height && prev.client === next.client) return prev
      return next
    })
  }, [])

  useEffect(() => {
    if (!showAnswerPanel) {
      setAnswerScroll({ top: 0, height: 0, client: 0 })
      return
    }
    syncAnswerScroll()
    const el = answerRef.current
    if (!el) return
    el.addEventListener('scroll', syncAnswerScroll, { passive: true })
    const ro = new ResizeObserver(syncAnswerScroll)
    ro.observe(el)
    // 内容是异步渲染的（MathJax），渲染完成后再同步一次
    const t = window.setTimeout(syncAnswerScroll, 600)
    return () => {
      el.removeEventListener('scroll', syncAnswerScroll)
      ro.disconnect()
      window.clearTimeout(t)
    }
  }, [showAnswerPanel, answerText, syncAnswerScroll])

  const answerCanScroll = answerScroll.height > answerScroll.client + 2

  // 滚轮：canvas 吃掉事件后不会传给面板，这里按指针位置手动转发
  useEffect(() => {
    if (!showAnswerPanel) return
    const onWheel = (e: WheelEvent) => {
      // Ctrl/⌘ + 滚轮是白板缩放，不归这里管
      if (e.ctrlKey || e.metaKey) return
      const el = answerRef.current
      if (!el || el.scrollHeight <= el.clientHeight + 2) return
      const r = el.getBoundingClientRect()
      if (e.clientY < r.top || e.clientY > r.bottom) return
      // 触控板横向手势不拦
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return
      e.preventDefault()
      el.scrollTop += e.deltaY
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [showAnswerPanel])

  // ↑/↓ 翻解析（←/→ 与 PageUp/PageDown 留给翻题，见 WhiteboardPage）
  useEffect(() => {
    if (!showAnswerPanel) return
    const onKey = (e: KeyboardEvent) => {
      const el = answerRef.current
      if (!el || el.scrollHeight <= el.clientHeight + 2) return
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const step = e.shiftKey ? el.clientHeight * 0.9 : 90
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        el.scrollTop += step
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        el.scrollTop -= step
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showAnswerPanel])

  const scrollAnswerTo = useCallback((top: number) => {
    const el = answerRef.current
    if (el) el.scrollTop = top
  }, [])

  return (
    <>
      <div
        className="wb-question-layer"
        style={answerExpand > 0 ? { transform: `translateY(${-answerExpand}px)` } : undefined}
      >
        <div className="wb-q-head">
          <span className="wb-q-badge">
            第 {index + 1} / {total} 题
          </span>
          {item.type && <span className="wb-q-badge">{TYPE_LABEL[item.type] || item.type}</span>}
        </div>

        <div
          ref={clipRef}
          style={{
            height: availH - 44,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div
            ref={measureRef}
            className="wb-q-measure"
            style={{ transform: `scale(${scale})` }}
          >
            <div className="wb-q-body">
              <MathJaxPreview
                latex={item.content}
                imageUrls={imageMap}
                questionType={item.type}
                imgMaxWidth={420}
                style={{ fontSize: 26, lineHeight: 1.8 }}
                onRendered={handlePreviewRendered}
              />
            </div>

            {item.options && item.options.length > 0 && (
              <div className="wb-options">
                {item.options.map((opt, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: '#534ab7', fontWeight: 600, flex: '0 0 auto' }}>
                      {OPTION_LABELS[i] || `${i + 1}`}.
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <MathJaxPreview
                        latex={opt}
                        imageUrls={imageMap}
                        questionType={item.type}
                        imgMaxWidth={300}
                        style={{ fontSize: 25, lineHeight: 1.7 }}
                        onRendered={handlePreviewRendered}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showAnswerPanel && (
        <>
          <div
            className="wb-answer-panel"
            style={answerExpand > 0 ? { height: ANSWER_PANEL_H + answerExpand } : undefined}
          >
            <div className="wb-answer-title">
              答案与解析
              {item.answer && (
                <span style={{ color: '#16a34a', fontSize: 22 }}>答案：{item.answer}</span>
              )}
              {answerCanScroll && (
                <span className="wb-answer-hint">
                  解析较长：滚轮 / ↑↓ 键翻动，或拖右侧滚动条
                </span>
              )}
            </div>
            <div className="wb-answer-body" ref={answerRef}>
              <MathJaxPreview
                latex={answerText || '(无解析)'}
                imageUrls={imageMap}
                questionType={item.type}
                imgMaxWidth={360}
                style={{ fontSize: 23, lineHeight: 1.75 }}
              />
            </div>
          </div>

          {/* 滚动条画在批注 canvas 之上（z-index 15），否则既看不见也拖不到 */}
          {answerCanScroll && (
            <AnswerScrollRail
              info={answerScroll}
              onScrollTo={scrollAnswerTo}
              bottomOffset={answerExpand}
            />
          )}
        </>
      )}
    </>
  )
}

/**
 * 解析面板的滚动条。
 * 不能依赖原生滚动条：批注 canvas 盖在面板上方，原生滚动条被遮住且点不到。
 * 这是画在 canvas 之上的自定义滚动条，鼠标 / 触屏 / 手写笔都能拖。
 */
function AnswerScrollRail({
  info,
  onScrollTo,
  bottomOffset = 0,
}: {
  info: { top: number; height: number; client: number }
  onScrollTo: (top: number) => void
  /** 解析面板额外长高的高度，滚动条要跟着变长 */
  bottomOffset?: number
}) {
  const RAIL_W = 18
  const panelH = ANSWER_PANEL_H + bottomOffset
  const TRACK_TOP = STAGE_H - panelH + 10
  const TRACK_H = panelH - 20
  const maxScroll = Math.max(1, info.height - info.client)
  const thumbH = Math.max(56, (info.client / info.height) * TRACK_H)
  const travel = TRACK_H - thumbH
  const thumbTop = TRACK_TOP + (info.top / maxScroll) * travel

  const dragRef = useRef<{ startY: number; startTop: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, startTop: info.top }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || travel <= 0) return
    e.preventDefault()
    // 滚动条在缩放后的舞台内部：先把屏幕位移换算成舞台逻辑位移，再换算成内容位移
    const rect = e.currentTarget.getBoundingClientRect()
    const stageScale = rect.height / TRACK_H || 1
    const logicalDelta = (e.clientY - d.startY) / stageScale
    onScrollTo(d.startTop + logicalDelta * (maxScroll / travel))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 已释放 */
    }
  }

  // 点击轨道空白处：向上/向下翻一屏
  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current) return
    const y = e.clientY
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const rel = ((y - rect.top) / rect.height) * TRACK_H
    onScrollTo(rel < thumbTop - TRACK_TOP ? info.top - info.client * 0.9 : info.top + info.client * 0.9)
  }

  return (
    <div
      className="wb-scroll-rail"
      style={{ width: RAIL_W, top: TRACK_TOP, height: TRACK_H }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={onTrackClick}
      title="拖动滚动解析"
    >
      <div className="wb-scroll-thumb" style={{ top: thumbTop - TRACK_TOP, height: thumbH }} />
    </div>
  )
}
