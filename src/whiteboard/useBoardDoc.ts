// 白板文档状态：笔画 / 撤销重做 / 当前页 / 答案开关 + 本地自动保存
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { emptyDoc, loadDoc, saveDoc } from './storage'
import type { BoardAction, BoardDoc, BoardItem, Stroke } from './types'

/** 本地自动保存的防抖间隔 */
const AUTOSAVE_DEBOUNCE_MS = 800

export interface UseBoardDocResult {
  doc: BoardDoc
  currentStrokes: Stroke[]
  currentPageId: string
  showAnswer: boolean
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  addStroke: (s: Stroke) => void
  eraseStrokes: (ids: string[]) => void
  /** 框选后移动/缩放：用变换后的笔画替换原来的那组 */
  transformStrokes: (before: Stroke[], after: Stroke[]) => void
  /** 删除当前选中的笔画 */
  deleteStrokes: (ids: string[]) => void
  clearPage: () => void
  goTo: (index: number) => void
  toggleAnswer: () => void
  /** 清空全部批注（新的一课） */
  resetAll: () => void
  storageWarning: string | null
  /** 首次挂载时读到的、需要用户确认的旧板书时间 */
  recoveredAt: number | null
  dismissRecovered: () => void
  flush: () => void
}

export function useBoardDoc(items: BoardItem[], initialIndex?: number | null): UseBoardDocResult {
  // 首次挂载读取一次本地存档；恢复确认由 recoveredAt 驱动
  const initial = useMemo(() => loadDoc(), [])
  const [doc, setDoc] = useState<BoardDoc>(() => {
    const base = initial || emptyDoc()
    // 从「加入白板」进来时定位到指定页
    if (typeof initialIndex === 'number' && initialIndex >= 0) {
      return { ...base, currentIndex: initialIndex }
    }
    return base
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })
  const [recoveredAt, setRecoveredAt] = useState<number | null>(() => {
    if (!initial) return null
    const hasStrokes = Object.values(initial.strokes).some(s => s.length > 0)
    if (!hasStrokes) return null
    // 超过 2 小时视为上一节课的板书，提示用户确认
    const stale = Date.now() - (initial.updatedAt || 0) > 2 * 60 * 60 * 1000
    return stale ? initial.updatedAt : null
  })

  const undoStackRef = useRef<BoardAction[]>([])
  const redoStackRef = useRef<BoardAction[]>([])
  const [, forceTick] = useState(0)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)

  const total = items.length
  const currentIndex = Math.min(Math.max(0, doc.currentIndex), Math.max(0, total - 1))
  const currentPageId = items[currentIndex]?.pageId ?? ''
  const currentStrokes = doc.strokes[currentPageId] || []
  const showAnswer = Boolean(doc.showAnswer[currentPageId])

  // ---------- 持久化 ----------

  const persist = useCallback((next: BoardDoc) => {
    const ok = saveDoc(next)
    setStorageWarning(ok ? null : '本次板书过大，已停止自动保存。建议导出后清空重开。')
  }, [])

  const docRef = useRef(doc)
  docRef.current = doc

  // 防抖保存
  useEffect(() => {
    const t = window.setTimeout(() => persist(docRef.current), AUTOSAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [doc, persist])

  // 页面隐藏 / 关闭前立即落盘，覆盖合盖、切窗口、刷新
  useEffect(() => {
    const flushNow = () => persist(docRef.current)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushNow()
    }
    window.addEventListener('pagehide', flushNow)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flushNow)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [persist])

  // 退出白板时立即落盘：防抖计时器会被 cleanup 清掉，
  // 若不在这里 flush，刚画完就点「返回组卷」会丢掉最后一笔。
  useEffect(() => {
    return () => {
      saveDoc(docRef.current)
    }
  }, [])

  const flush = useCallback(() => persist(docRef.current), [persist])

  // ---------- 动作 ----------

  const applyAction = useCallback((pageId: string, action: BoardAction, mutate: (list: Stroke[]) => Stroke[]) => {
    setDoc(prev => {
      const list = prev.strokes[pageId] || []
      const nextList = mutate(list.slice())
      const strokes = { ...prev.strokes }
      if (nextList.length === 0) delete strokes[pageId]
      else strokes[pageId] = nextList
      return { ...prev, strokes }
    })
    undoStackRef.current.push(action)
    redoStackRef.current = []
    forceTick(t => t + 1)
  }, [])

  const addStroke = useCallback((s: Stroke) => {
    if (!currentPageId) return
    applyAction(currentPageId, { type: 'add', pageId: currentPageId, stroke: s }, list => {
      list.push(s)
      return list
    })
  }, [currentPageId, applyAction])

  const eraseStrokes = useCallback((ids: string[]) => {
    if (!currentPageId || ids.length === 0) return
    const idSet = new Set(ids)
    const list = docRef.current.strokes[currentPageId] || []
    const removed: { stroke: Stroke; index: number }[] = []
    list.forEach((s, i) => {
      if (idSet.has(s.id)) removed.push({ stroke: s, index: i })
    })
    if (removed.length === 0) return
    applyAction(currentPageId, { type: 'erase', pageId: currentPageId, items: removed }, cur => (
      cur.filter(s => !idSet.has(s.id))
    ))
  }, [currentPageId, applyAction])

  /** 框选变换：按 id 原地替换，保持 z 序不变 */
  const transformStrokes = useCallback((before: Stroke[], after: Stroke[]) => {
    if (!currentPageId || before.length === 0) return
    const map = new Map(after.map(s => [s.id, s]))
    const snapshot = before.slice()
    const replaced = after.slice()
    applyAction(
      currentPageId,
      { type: 'transform', pageId: currentPageId, before: snapshot, after: replaced },
      list => list.map(s => map.get(s.id) ?? s),
    )
  }, [currentPageId, applyAction])

  /** 删除选中：复用「擦除」动作，撤销行为一致 */
  const deleteStrokes = useCallback((ids: string[]) => {
    eraseStrokes(ids)
  }, [eraseStrokes])

  const clearPage = useCallback(() => {
    if (!currentPageId) return
    const list = docRef.current.strokes[currentPageId] || []
    if (list.length === 0) return
    applyAction(currentPageId, { type: 'clear', pageId: currentPageId, strokes: list.slice() }, () => [])
  }, [currentPageId, applyAction])

  const undo = useCallback(() => {
    const action = undoStackRef.current.pop()
    if (!action) return
    setDoc(prev => {
      const strokes = { ...prev.strokes }
      const list = (strokes[action.pageId] || []).slice()
      if (action.type === 'add') {
        const i = list.findIndex(s => s.id === action.stroke.id)
        if (i >= 0) list.splice(i, 1)
      } else if (action.type === 'erase') {
        // 按原索引升序插回，保证顺序正确
        for (const { stroke, index } of [...action.items].sort((a, b) => a.index - b.index)) {
          list.splice(Math.min(index, list.length), 0, stroke)
        }
      } else if (action.type === 'transform') {
        const map = new Map(action.before.map(s => [s.id, s]))
        for (let i = 0; i < list.length; i++) {
          const orig = map.get(list[i].id)
          if (orig) list[i] = orig
        }
      } else if (action.type === 'clear') {
        list.push(...action.strokes)
      }
      if (list.length === 0) delete strokes[action.pageId]
      else strokes[action.pageId] = list
      return { ...prev, strokes }
    })
    redoStackRef.current.push(action)
    forceTick(t => t + 1)
  }, [])

  const redo = useCallback(() => {
    const action = redoStackRef.current.pop()
    if (!action) return
    setDoc(prev => {
      const strokes = { ...prev.strokes }
      const list = (strokes[action.pageId] || []).slice()
      if (action.type === 'add') {
        if (!list.some(s => s.id === action.stroke.id)) list.push(action.stroke)
      } else if (action.type === 'erase') {
        const idSet = new Set(action.items.map(i => i.stroke.id))
        const keep = list.filter(s => !idSet.has(s.id))
        list.length = 0
        list.push(...keep)
      } else if (action.type === 'transform') {
        const map = new Map(action.after.map(s => [s.id, s]))
        for (let i = 0; i < list.length; i++) {
          const moved = map.get(list[i].id)
          if (moved) list[i] = moved
        }
      } else if (action.type === 'clear') {
        list.length = 0
      }
      if (list.length === 0) delete strokes[action.pageId]
      else strokes[action.pageId] = list
      return { ...prev, strokes }
    })
    undoStackRef.current.push(action)
    forceTick(t => t + 1)
  }, [])

  const goTo = useCallback((index: number) => {
    const clamped = Math.min(Math.max(0, index), Math.max(0, items.length - 1))
    setDoc(prev => (prev.currentIndex === clamped ? prev : { ...prev, currentIndex: clamped }))
  }, [items.length])

  const toggleAnswer = useCallback(() => {
    if (!currentPageId) return
    setDoc(prev => ({
      ...prev,
      showAnswer: { ...prev.showAnswer, [currentPageId]: !prev.showAnswer[currentPageId] },
    }))
  }, [currentPageId])

  const resetAll = useCallback(() => {
    undoStackRef.current = []
    redoStackRef.current = []
    const fresh = emptyDoc()
    setDoc(fresh)
    setRecoveredAt(null)
    setStorageWarning(null)
    persist(fresh)
  }, [persist])

  return {
    doc,
    currentStrokes,
    currentPageId,
    showAnswer,
    undo,
    redo,
    canUndo: undoStackRef.current.length > 0,
    canRedo: redoStackRef.current.length > 0,
    addStroke,
    eraseStrokes,
    transformStrokes,
    deleteStrokes,
    clearPage,
    goTo,
    toggleAnswer,
    resetAll,
    storageWarning,
    recoveredAt,
    dismissRecovered: () => setRecoveredAt(null),
    flush,
  }
}
