// 白板数据类型定义

/** 白板上的一页 = 一道题（存快照，不按 id 回查题库） */
export interface BoardItem {
  pageId: string
  questionId: string
  type: string
  content: string
  options?: string[]
  /** 解析（优先展示） */
  analysis?: string
  /** 答案解析正文（analysis 为空时的回退） */
  answerContent?: string
  /** 选择题正确答案，如 "C" */
  answer?: string
  images: Record<string, string>
  addedAt: number
}

/** 一个采样点：逻辑坐标 + 压感 0~1 */
export interface Point {
  x: number
  y: number
  p: number
}

export interface Stroke {
  id: string
  tool: 'pen' | 'highlighter'
  color: string
  /** 逻辑 px */
  width: number
  points: Point[]
  createdAt: number
}

/** 白板文档：笔画、页码、答案开关（按 pageId 索引） */
export interface BoardDoc {
  version: 1
  strokes: Record<string, Stroke[]>
  currentIndex: number
  showAnswer: Record<string, boolean>
  updatedAt: number
}

/** 撤销/重做动作栈的元素 */
export type BoardAction =
  | { type: 'add'; pageId: string; stroke: Stroke }
  | { type: 'erase'; pageId: string; items: { stroke: Stroke; index: number }[] }
  | { type: 'clear'; pageId: string; strokes: Stroke[] }
  /** 框选后移动/缩放：记录变换前后的整组笔画 */
  | { type: 'transform'; pageId: string; before: Stroke[]; after: Stroke[] }

export const BOARD_VERSION = 1 as const

/** 白板逻辑版面尺寸（16:9，投影友好） */
export const STAGE_W = 1600
export const STAGE_H = 900

/** 答案面板高度（显示答案时题目区让出这么多） */
export const ANSWER_PANEL_H = 400

/** 解析面板最多能再长高多少（从 400 涨到铺满整个版面 900） */
export const ANSWER_EXPAND_MAX = STAGE_H - ANSWER_PANEL_H

/** 缩放范围 */
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 4
