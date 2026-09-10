// 板级滑动条：把解析面板的顶端滑到页面顶部
//
// 与 QuestionLayer 里那根「解析内容滚动条」是两回事：
//   内容条 = 在 400px 面板内部滚动长解析（受面板高度限制）
//   本条   = 让面板本身从 400 长到铺满整个版面，把题目和板书顶出屏幕
// 所以本条放在视口最右侧（像页面滚动条），内容条留在版面右缘，位置与配色都区分开。
import React, { useCallback, useRef } from 'react'
import { ANSWER_EXPAND_MAX, ANSWER_PANEL_H, STAGE_H } from './types'

/** 题目区高度（滑动范围的另一半） */
const QUESTION_H = STAGE_H - ANSWER_PANEL_H
/** 把整个版面视作一份文档：题目区 + 完全展开的解析 */
const DOC_H = QUESTION_H + STAGE_H
/** 当前窗口高度 = 一个版面 */
const WINDOW_H = STAGE_H

interface Props {
  /** 当前展开量 0 ~ ANSWER_EXPAND_MAX */
  value: number
  onChange: (v: number) => void
}

export default function BoardScrollRail({ value, onChange }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null)

  const fraction = WINDOW_H / DOC_H
  const thumbFrac = Math.max(0.12, Math.min(1, fraction))
  const posFrac = ANSWER_EXPAND_MAX > 0 ? value / ANSWER_EXPAND_MAX : 0

  /** 把轨道上的点击位置换算成展开量 */
  const trackValueAt = useCallback((clientY: number) => {
    const el = trackRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const rel = (clientY - r.top) / r.height
    const travel = 1 - thumbFrac
    if (travel <= 0) return 0
    // rel 是拇指顶端的相对位置，换算回滚动比例
    const t = Math.min(1, Math.max(0, (rel - thumbFrac / 2) / travel))
    return t * ANSWER_EXPAND_MAX
  }, [thumbFrac])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, startValue: value }
    if ((e.target as HTMLElement).dataset.thumb !== '1') {
      onChange(trackValueAt(e.clientY))
      dragRef.current.startValue = trackValueAt(e.clientY)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    e.preventDefault()
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const travel = (1 - thumbFrac) * r.height
    if (travel <= 0) return
    const delta = ((e.clientY - d.startY) / travel) * ANSWER_EXPAND_MAX
    onChange(Math.min(ANSWER_EXPAND_MAX, Math.max(0, d.startValue + delta)))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 已释放 */
    }
  }

  // 滚轮：悬停在滑动条上时也管用
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    onChange(Math.min(ANSWER_EXPAND_MAX, Math.max(0, value - e.deltaY * 0.6)))
  }

  const thumbTop = posFrac * (1 - thumbFrac) * 100

  return (
    <div
      ref={trackRef}
      className="wb-board-rail"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
      title="上下拖动：把解析滑到页面顶部（滑到底题目和板书重新出现）"
    >
      <div
        data-thumb="1"
        className="wb-board-thumb"
        style={{ top: `${thumbTop}%`, height: `${thumbFrac * 100}%` }}
      />
    </div>
  )
}
