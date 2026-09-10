// 白板本地持久化（localStorage）
// 两个 key 各有唯一写入方：items 由 App 写，doc 由白板页写，避免互相覆盖
import { BOARD_VERSION, type BoardDoc, type BoardItem, type Point, type Stroke } from './types'

const ITEMS_KEY = 'mathwb:items:v1'
const DOC_KEY = 'mathwb:doc:v1'
const PREFS_KEY = 'mathwb:prefs:v1'

/** 单笔最多保留的采样点数 */
const MAX_POINTS_PER_STROKE = 1200
/** 单页最多保留的笔画数 */
const MAX_STROKES_PER_PAGE = 2000
/** 最多保留的页数 */
const MAX_PAGES = 50
/** 抽稀阈值：与上一个保留点距离小于此值则丢弃（逻辑 px） */
const MIN_POINT_DIST = 1.0

// ---------- 工具 ----------

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** 坐标量化到 0.1，压感量化到 0.01，显著减小序列化体积 */
function quantizePoint(p: Point): Point {
  return {
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
    p: Math.round(p.p * 100) / 100,
  }
}

/**
 * 抽稀 + 量化一组点。首尾点必定保留，保证笔画起止位置不变。
 */
export function thinPoints(points: Point[]): Point[] {
  if (points.length <= 2) return points.map(quantizePoint)
  const out: Point[] = [quantizePoint(points[0])]
  let last = points[0]
  for (let i = 1; i < points.length - 1; i++) {
    const pt = points[i]
    const dx = pt.x - last.x
    const dy = pt.y - last.y
    if (dx * dx + dy * dy >= MIN_POINT_DIST * MIN_POINT_DIST) {
      out.push(quantizePoint(pt))
      last = pt
    }
    if (out.length >= MAX_POINTS_PER_STROKE - 1) break
  }
  out.push(quantizePoint(points[points.length - 1]))
  return out
}

// ---------- 题目快照（App 侧写） ----------

export function loadBoardItems(): BoardItem[] {
  const data = safeParse<BoardItem[]>(localStorage.getItem(ITEMS_KEY))
  if (!Array.isArray(data)) return []
  return data.filter(x => x && typeof x.pageId === 'string')
}

/** 写入题目快照。返回 false 表示超配额（调用方应提示用户） */
export function saveBoardItems(items: BoardItem[]): boolean {
  try {
    localStorage.setItem(ITEMS_KEY, JSON.stringify(items.slice(0, MAX_PAGES)))
    return true
  } catch (err) {
    console.error('白板题目保存失败:', err)
    return false
  }
}

/** 从题库题目构造白板页快照 */
export function makeBoardItem(q: {
  id: string
  type?: string
  content?: string
  options?: string[]
  analysis?: string
  answerContent?: string
  answer?: string
  images?: Record<string, string>
}): BoardItem {
  return {
    pageId: `pg-${q.id}`,
    questionId: q.id,
    type: q.type || '',
    content: q.content || '',
    options: Array.isArray(q.options) && q.options.length > 0 ? q.options : undefined,
    analysis: q.analysis || '',
    answerContent: q.answerContent || '',
    answer: q.answer || '',
    images: q.images && typeof q.images === 'object' ? q.images : {},
    addedAt: Date.now(),
  }
}

// ---------- 白板文档（白板页侧写） ----------

export function emptyDoc(): BoardDoc {
  return { version: BOARD_VERSION, strokes: {}, currentIndex: 0, showAnswer: {}, updatedAt: Date.now() }
}

export function loadDoc(): BoardDoc | null {
  const data = safeParse<BoardDoc>(localStorage.getItem(DOC_KEY))
  if (!data || data.version !== BOARD_VERSION || typeof data.strokes !== 'object') return null
  return data
}

/** 写入前统一做容量裁剪。返回 false 表示超配额 */
export function saveDoc(doc: BoardDoc): boolean {
  const trimmed: BoardDoc = {
    ...doc,
    updatedAt: Date.now(),
    strokes: {},
  }
  for (const [pageId, strokes] of Object.entries(doc.strokes)) {
    const kept = strokes
      .slice(-MAX_STROKES_PER_PAGE)
      .map(s => ({ ...s, points: thinPoints(s.points) }))
      .filter(s => s.points.length > 0)
    if (kept.length > 0) trimmed.strokes[pageId] = kept
  }
  try {
    localStorage.setItem(DOC_KEY, JSON.stringify(trimmed))
    return true
  } catch (err) {
    console.error('白板板书保存失败（可能超出浏览器存储配额）:', err)
    return false
  }
}

// ---------- 工具偏好（小对象，不参与裁剪） ----------

export interface BoardPrefs {
  /** 记录上次用的工具（含橡皮/只读，这样下次打开还是同一套手感） */
  tool: 'pen' | 'highlighter' | 'eraser' | 'select' | 'pan' | 'none'
  color: string
  size: number
}

export function loadPrefs(): Partial<BoardPrefs> {
  return safeParse<Partial<BoardPrefs>>(localStorage.getItem(PREFS_KEY)) || {}
}

export function savePrefs(prefs: BoardPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* 忽略：偏好丢失不影响上课 */
  }
}

/** 导出/导入用的 JSON 备份 */
export function exportBackup(items: BoardItem[], doc: BoardDoc): string {
  return JSON.stringify({ kind: 'mathwb-backup', version: BOARD_VERSION, items, doc }, null, 1)
}

export function importBackup(text: string): { items: BoardItem[]; doc: BoardDoc } | null {
  const data = safeParse<{ kind?: string; items?: BoardItem[]; doc?: BoardDoc }>(text)
  if (!data || data.kind !== 'mathwb-backup' || !Array.isArray(data.items) || !data.doc) return null
  return { items: data.items, doc: data.doc }
}

