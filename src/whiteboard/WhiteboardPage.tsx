// 白板页：全屏壳 + 工具栏 + 翻页 + 全屏 + 导出 + 云保存
// 一题一页；题目用 MathJax 矢量渲染（投影放大不糊），上面叠一层透明 canvas 手写批注。
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/auth'
import AnnotationCanvas, { type BoardTool } from './AnnotationCanvas'
import QuestionLayer from './QuestionLayer'
import CloudBoardDialog from './CloudBoardDialog'
import BoardScrollRail from './BoardScrollRail'
import { useBoardDoc } from './useBoardDoc'
import { exportAllPdf, exportPagePng, pageHasBrokenImages, renderStageToCanvas } from './boardExport'
import { exportBackup, importBackup, loadPrefs, savePrefs } from './storage'
import * as cloud from './cloud'
import { STAGE_H, STAGE_W, ZOOM_MAX, ZOOM_MIN, type BoardDoc, type BoardItem, type Stroke } from './types'
import './whiteboard.css'

const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#ea580c']
const SIZES = [
  { label: '细', value: 3 },
  { label: '中', value: 6 },
  { label: '粗', value: 11 },
]

/** PDF 导出时，等页面（公式+图片）就绪的最长时间 */
const PAGE_READY_TIMEOUT = 6000

interface Props {
  items: BoardItem[]
  /** 打开时定位到的页；null 表示沿用上次停留的页 */
  initialIndex?: number | null
  onExit: () => void
  onRemoveItem: (pageId: string) => void
  /** 云端载入：整体替换题目与板书（由 App 落盘并重挂白板） */
  onLoadBoard: (items: BoardItem[], doc: BoardDoc) => void
}

export default function WhiteboardPage({ items, initialIndex, onExit, onRemoveItem, onLoadBoard }: Props) {
  const { user } = useAuth()
  const initialPrefs = useRef(loadPrefs()).current

  const board = useBoardDoc(items, initialIndex)
  const [tool, setTool] = useState<BoardTool>('pen')
  const [color, setColor] = useState(initialPrefs.color || COLORS[0])
  const [size, setSize] = useState(initialPrefs.size || SIZES[1].value)
  const [scale, setScale] = useState(1)
  // 用户缩放（1 = 适应屏幕）与平移（屏幕像素）
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // 事件监听里要读最新 zoom，避免闭包过期
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  // 当前框选中的笔画 id（用于工具栏的「删除选中」）
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  // 按住空格临时切到平移（松开还原），不改变实际选中的工具
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // 解析面板额外长高的高度（0 = 常规 400px，ANSWER_EXPAND_MAX = 铺满整个版面）
  const [answerExpand, setAnswerExpand] = useState(0)
  const [showCloud, setShowCloud] = useState(false)
  const [cloudId, setCloudId] = useState<string | null>(null)
  const [cloudTitle, setCloudTitle] = useState('')

  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const renderWaitersRef = useRef<(() => void)[]>([])

  const total = items.length
  const index = Math.min(board.doc.currentIndex, Math.max(0, total - 1))
  const currentItem = items[index]

  // ---------- 舞台缩放：逻辑版面 1600×900 等比铺满视口 ----------

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const compute = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0 || h <= 0) return
      setScale(Math.max(0.1, Math.min(w / STAGE_W, h / STAGE_H)))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 白板是全屏覆盖层，期间禁止页面本身滚动（触屏书写时尤其重要）
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // ---------- 提示条 ----------

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(t => (t === msg ? null : t)), 3200)
  }, [])

  const storageWarning = board.storageWarning

  useEffect(() => {
    if (storageWarning) flash(storageWarning)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageWarning])

  // ---------- 工具偏好记忆 ----------

  useEffect(() => {
    savePrefs({ tool, color, size })
  }, [tool, color, size])

  // 换题时清空框选，避免选中状态跨页残留
  useEffect(() => {
    setSelectedIds([])
  }, [index, board.currentPageId])

  // ---------- 缩放与平移 ----------

  /** 把平移量钳制在合理范围内：版面比视口小就居中，比视口大才能拖 */
  const clampPan = useCallback((x: number, y: number, z = zoom) => {
    const el = viewportRef.current
    if (!el) return { x: 0, y: 0 }
    const S = scale * z
    const maxX = Math.max(0, (STAGE_W * S - el.clientWidth) / 2)
    const maxY = Math.max(0, (STAGE_H * S - el.clientHeight) / 2)
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    }
  }, [scale, zoom])

  const applyPan = useCallback((dx: number, dy: number) => {
    setPan(p => clampPan(p.x + dx, p.y + dy))
  }, [clampPan])

  const setZoomClamped = useCallback((next: number, anchorClientX?: number, anchorClientY?: number) => {
    const el = viewportRef.current
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
    if (!el) {
      setZoom(z)
      return
    }
    setZoom(prev => {
      const S = scale * prev
      const S2 = scale * z
      if (S <= 0 || S2 <= 0) return z
      const rect = el.getBoundingClientRect()
      const cx = anchorClientX ?? rect.left + rect.width / 2
      const cy = anchorClientY ?? rect.top + rect.height / 2
      // 光标下的逻辑点保持不变：由 screen = center + pan + S·(logical - stageCenter) 反解
      setPan(p => {
        const logicalX = 800 + (cx - (rect.left + rect.width / 2) - p.x) / S
        const logicalY = 450 + (cy - (rect.top + rect.height / 2) - p.y) / S
        const nx = cx - (rect.left + rect.width / 2) - S2 * (logicalX - 800)
        const ny = cy - (rect.top + rect.height / 2) - S2 * (logicalY - 450)
        return clampPan(nx, ny, z)
      })
      return z
    })
  }, [scale, clampPan])

  const zoomBy = useCallback((factor: number) => {
    setZoomClamped(zoom * factor)
  }, [zoom, setZoomClamped])

  const resetZoom = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  // Ctrl+滚轮缩放（以光标为锚点）。解析面板内容滚动的监听里会跳过带 Ctrl 的事件
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoomClamped(zoomRef.current * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setZoomClamped])

  // 缩放变化后重新钳制平移，避免缩小后版面飞出视野
  useEffect(() => {
    setPan(p => clampPan(p.x, p.y))
  }, [clampPan])

  // ---------- 翻页 ----------

  const goPrev = useCallback(() => board.goTo(index - 1), [board, index])
  const goNext = useCallback(() => board.goTo(index + 1), [board, index])

  // 换题或收起答案时，解析面板回到常规高度
  useEffect(() => {
    setAnswerExpand(0)
  }, [index, board.showAnswer])

  const handleRemovePage = useCallback((pageId: string) => {
    if (!window.confirm('从白板移除这道题？该页的板书也会一并删除。')) return
    onRemoveItem(pageId)
  }, [onRemoveItem])

  // ---------- 全屏 ----------

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch (err) {
      console.error('全屏切换失败:', err)
    }
  }, [])

  // ---------- 快捷键 ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) board.redo()
        else board.undo()
        return
      }
      switch (e.key) {
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault(); goPrev(); break
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault(); goNext(); break
        case 'a': case 'A':
          e.preventDefault(); board.toggleAnswer(); break
        case 'p': case 'P':
          e.preventDefault(); setTool('pen'); break
        case 'h': case 'H':
          e.preventDefault(); setTool('highlighter'); break
        case 'e': case 'E':
          e.preventDefault(); setTool('eraser'); break
        case 'v': case 'V':
          e.preventDefault(); setTool('select'); break
        case 'f': case 'F':
          e.preventDefault(); toggleFullscreen(); break
        case 'Escape':
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
          else setSelectedIds([])
          break
        case 'Delete':
        case 'Backspace':
          // 有框选时优先删选中，避免误清整页
          if (selectedIdsRef.current.length > 0) {
            e.preventDefault()
            board.deleteStrokes(selectedIdsRef.current)
            setSelectedIds([])
          }
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [board, goPrev, goNext, toggleFullscreen])

  // 按住空格临时平移，松开还原（和设计软件一致）
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      e.preventDefault()
      setSpaceHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // ---------- 导出 ----------

  const waitForPageReady = useCallback((timeout = PAGE_READY_TIMEOUT) => {
    return new Promise<void>(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        // 再等一拍，让图片解码和布局落定
        window.setTimeout(resolve, 250)
      }
      const timer = window.setTimeout(finish, timeout)
      renderWaitersRef.current.push(finish)
    })
  }, [])

  const handlePageRendered = useCallback(() => {
    const waiters = renderWaitersRef.current
    renderWaitersRef.current = []
    waiters.forEach(w => w())
  }, [])

  const buildExportInput = useCallback((pageIndex: number) => {
    const stage = stageRef.current
    if (!stage) throw new Error('白板尚未就绪')
    const pageItem = items[pageIndex]
    const strokes = pageItem ? board.doc.strokes[pageItem.pageId] || [] : []
    const broken = pageHasBrokenImages(stage)
    if (broken > 0) flash(`有 ${broken} 张题图未加载，导出结果可能不含图片`)
    return {
      stage,
      strokes,
      title: pageItem ? `白板-第${pageIndex + 1}题` : '白板',
    }
  }, [items, board.doc, flash])

  const handleExportPng = useCallback(async () => {
    setBusy('正在导出图片…')
    try {
      board.flush()
      await exportPagePng(buildExportInput(index))
      flash('已导出当前页 PNG')
    } catch (err) {
      console.error(err)
      flash(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }, [board, buildExportInput, index, flash])

  const handleExportPdf = useCallback(async () => {
    if (total === 0) return
    setBusy('正在导出 PDF…')
    const originalIndex = index
    try {
      board.flush()
      // 每一页必须在它正显示时立刻渲染，不能先收集再统一渲染
      await exportAllPdf(
        total,
        async i => {
          board.goTo(i)
          setBusy(`正在导出 PDF… ${i + 1}/${total}`)
          await waitForPageReady()
          return renderStageToCanvas(buildExportInput(i))
        },
        '白板板书',
        (done, all) => setBusy(`正在导出 PDF… ${done}/${all}`),
      )
      flash('已导出多页 PDF')
    } catch (err) {
      console.error(err)
      flash(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      board.goTo(originalIndex)
      setBusy(null)
    }
  }, [board, total, index, waitForPageReady, buildExportInput, flash])

  // ---------- 备份导入导出 ----------

  const handleExportJson = useCallback(() => {
    try {
      const text = exportBackup(items, board.doc)
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = '白板备份.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      flash('已导出 JSON 备份')
    } catch (err) {
      flash(`备份失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [items, board.doc, flash])

  const handleImportJson = useCallback(async (file: File) => {
    try {
      const parsed = importBackup(await file.text())
      if (!parsed) {
        flash('这个文件不是白板备份')
        return
      }
      // 交给 App 落盘并重挂，题目与板书一起替换
      onLoadBoard(parsed.items, parsed.doc)
      flash('已导入备份')
    } catch (err) {
      flash(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [onLoadBoard, flash])

  // ---------- 云保存 ----------

  const handleCloudSave = useCallback(async () => {
    if (!user) {
      flash('未登录，无法保存到云端')
      return
    }
    if (items.length === 0) {
      flash('白板里还没有题目')
      return
    }
    const title = window.prompt('给这块白板起个名字：', cloudTitle || `白板 ${new Date().toLocaleDateString('zh-CN')}`)
    if (title === null) return
    setBusy('正在保存到云端…')
    try {
      const id = await cloud.saveBoard(cloudId, title, { items, doc: board.doc }, user.id)
      setCloudId(id)
      setCloudTitle(title)
      flash('已保存到云端')
    } catch (err) {
      flash(cloud.describeCloudError(err))
    } finally {
      setBusy(null)
    }
  }, [user, items, board.doc, cloudId, cloudTitle, flash])

  const handleCloudOpen = useCallback(async (id: string) => {
    setShowCloud(false)
    setBusy('正在打开云端白板…')
    try {
      const payload = await cloud.loadBoard(id)
      setCloudId(id)
      setCloudTitle('已载入')
      // 交给 App 落盘并重挂白板状态，避免整页刷新
      onLoadBoard(payload.items, payload.doc)
    } catch (err) {
      flash(cloud.describeCloudError(err))
    } finally {
      setBusy(null)
    }
  }, [onLoadBoard, flash])

  // ---------- 渲染 ----------

  const renderStrokes = board.currentStrokes
  const effectiveTool: BoardTool = spaceHeld ? 'pan' : tool

  return (
    <div className="wb-root">
      <div className="wb-toolbar">
        <div className="wb-row">
          <button className="wb-btn" onClick={onExit}>
            ← 返回组卷
          </button>
          <div className="wb-sep" />
          <button className="wb-btn" onClick={goPrev} disabled={index <= 0}>
            ‹ 上一题
          </button>
          <span className="wb-index">{total === 0 ? '0 / 0' : `${index + 1} / ${total}`}</span>
          <button className="wb-btn" onClick={goNext} disabled={index >= total - 1}>
            下一题 ›
          </button>

          <div className="wb-row-center" />

          <div className="wb-sep" />
          <button className="wb-btn" onClick={() => zoomBy(1 / 1.25)} title="缩小" disabled={zoom <= ZOOM_MIN}>
            🔍−
          </button>
          <button
            className="wb-btn"
            onClick={resetZoom}
            title="点击恢复「适应屏幕」"
            style={{ minWidth: 74, justifyContent: 'center' }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button className="wb-btn" onClick={() => zoomBy(1.25)} title="放大" disabled={zoom >= ZOOM_MAX}>
            🔍+
          </button>
          <button className="wb-btn" onClick={resetZoom} title="恢复到适应屏幕大小">
            适应
          </button>

          <div className="wb-sep" />
          {currentItem && (
            <button
              className="wb-btn is-danger"
              onClick={() => handleRemovePage(currentItem.pageId)}
              title="从白板移除当前这道题"
            >
              移除本题
            </button>
          )}
          <button className="wb-btn" onClick={handleExportPng} disabled={total === 0}>
            导出图片
          </button>
          <button className="wb-btn" onClick={handleExportPdf} disabled={total === 0}>
            导出 PDF
          </button>
          <button className="wb-btn" onClick={handleCloudSave} disabled={total === 0}>
            保存到云端
          </button>
          <button className="wb-btn" onClick={() => setShowCloud(true)}>
            云端白板
          </button>
          <button className="wb-btn" onClick={toggleFullscreen}>
            {isFullscreen ? '退出全屏' : '全屏'}
          </button>
        </div>

        <div className="wb-row">
          <button
            className={`wb-btn${tool === 'pen' ? ' is-active' : ''}`}
            onClick={() => setTool('pen')}
          >
            ✏️ 笔
          </button>
          <button
            className={`wb-btn${tool === 'highlighter' ? ' is-active' : ''}`}
            onClick={() => setTool('highlighter')}
          >
            🖍 荧光笔
          </button>
          <button
            className={`wb-btn${tool === 'eraser' ? ' is-active' : ''}`}
            onClick={() => setTool('eraser')}
          >
            🧽 橡皮
          </button>
          <button
            className={`wb-btn${tool === 'select' ? ' is-active' : ''}`}
            onClick={() => setTool('select')}
            title="框选板书：拖框选中，再拖动移动、拖角点缩放"
          >
            ⬚ 选择
          </button>
          <button
            className={`wb-btn${tool === 'pan' ? ' is-active' : ''}`}
            onClick={() => setTool('pan')}
            title="拖动画布（放大后用它看别处）"
          >
            ✋ 平移
          </button>

          <div className="wb-sep" />
          {COLORS.map(c => (
            <button
              key={c}
              className={`wb-swatch${color === c && tool !== 'eraser' ? ' is-active' : ''}`}
              style={{ background: c }}
              onClick={() => {
                setColor(c)
                if (tool === 'eraser' || tool === 'none') setTool('pen')
              }}
              title={c}
            />
          ))}

          <div className="wb-sep" />
          {SIZES.map(s => (
            <button
              key={s.value}
              className={`wb-size${size === s.value ? ' is-active' : ''}`}
              onClick={() => setSize(s.value)}
              title={`${s.label}（${s.value}px）`}
            >
              <span className="wb-size-dot" style={{ width: s.value + 2, height: s.value + 2 }} />
            </button>
          ))}

          <div className="wb-sep" />
          <button className="wb-btn" onClick={board.undo} disabled={!board.canUndo}>
            ↶ 撤销
          </button>
          <button className="wb-btn" onClick={board.redo} disabled={!board.canRedo}>
            ↷ 重做
          </button>
          <button
            className="wb-btn is-danger"
            onClick={() => {
              if (window.confirm('清空本页所有批注？')) board.clearPage()
            }}
          >
            清空本页
          </button>
          {selectedIds.length > 0 && (
            <button
              className="wb-btn is-danger"
              onClick={() => {
                board.deleteStrokes(selectedIds)
                setSelectedIds([])
              }}
              title="删除框选中的板书"
            >
              删除选中（{selectedIds.length}）
            </button>
          )}

          <div className="wb-row-center" />

          <button
            className={`wb-btn${board.showAnswer ? ' is-primary' : ''}`}
            onClick={board.toggleAnswer}
            disabled={!currentItem}
            title="快捷键 A"
          >
            {board.showAnswer ? '隐藏答案' : '显示答案'}
          </button>
        </div>
      </div>

      {board.recoveredAt !== null && (
        <div className="wb-banner">
          <span>
            已恢复 {new Date(board.recoveredAt).toLocaleString('zh-CN')} 的板书，需要接着用吗？
          </span>
          <button className="is-primary" onClick={board.dismissRecovered}>
            继续使用
          </button>
          <button
            onClick={() => {
              if (window.confirm('清空全部批注，开始新的一课？（题目会保留）')) board.resetAll()
            }}
          >
            新的一课（清空批注）
          </button>
        </div>
      )}

      <div className="wb-viewport" ref={viewportRef}>
        {total === 0 ? (
          <div className="wb-empty">
            <div className="wb-empty-icon">🧺</div>
            <div>白板里还没有题目</div>
            <div style={{ fontSize: 16 }}>回到「组卷」页，点题目上的「加入白板」</div>
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button className="wb-btn" style={{ background: '#534ab7' }} onClick={onExit}>
                去组卷页选题
              </button>
              <button className="wb-btn" style={{ background: '#6b7280' }} onClick={() => fileInputRef.current?.click()}>
                导入备份
              </button>
            </div>
          </div>
        ) : (
          <div
            className="wb-stage"
            ref={stageRef}
            style={{
              width: STAGE_W,
              height: STAGE_H,
              // 居中必须合并进 transform：舞台比视口大，grid/flex 居中会把它挤歪。
              // 平移放在 scale 之前，位移量就是屏幕像素，不受缩放影响。
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale * zoom})`,
            }}
          >
            {currentItem && (
              <QuestionLayer
                key={currentItem.pageId}
                item={currentItem}
                index={index}
                total={total}
                showAnswer={board.showAnswer}
                answerExpand={answerExpand}
                onRendered={handlePageRendered}
              />
            )}
            <AnnotationCanvas
              offsetY={answerExpand}
              scale={scale * zoom}
              tool={effectiveTool}
              color={color}
              size={size}
              strokes={renderStrokes}
              onCommit={board.addStroke}
              onErase={board.eraseStrokes}
              onTransform={board.transformStrokes}
              onPan={applyPan}
              onSelectionChange={setSelectedIds}
              onContextMenu={e => e.preventDefault()}
            />
          </div>
        )}
      </div>

      {/* 隐藏的备份导入入口（空状态与工具栏共用） */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) handleImportJson(f)
          e.target.value = ''
        }}
      />

      {/* 板级滑动条：把解析顶端滑到页面顶部（题目与板书随之上移出屏） */}
      {board.showAnswer && currentItem && (
        <BoardScrollRail value={answerExpand} onChange={setAnswerExpand} />
      )}

      {showCloud && (
        <CloudBoardDialog onOpen={handleCloudOpen} onClose={() => setShowCloud(false)} />
      )}

      {busy && <div className="wb-busy">{busy}</div>}
      {toast && <div className="wb-toast">{toast}</div>}
    </div>
  )
}
