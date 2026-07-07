import React, { useState, useEffect, useRef } from 'react'
import './App.css'
import DownloadedPapers from './DownloadedPapers'
import PdfBatchEntry from './PdfBatchEntry'
import { useAuth } from './lib/auth'
import { supabase } from './lib/supabase'
import { fetchBasket as supabaseFetchBasket, addToBasket as supabaseAddToBasket, removeFromBasket as supabaseRemoveFromBasket, clearBasket as supabaseClearBasket } from './lib/db'
const ExamComposer = React.lazy(() => import('./composer/ExamComposer'))

const API = 'http://localhost:3001'
const USE_SUPABASE_BASKET = true  // Use Supabase for basket (user-isolated)

// MathJax 全局类型声明
declare global {
  interface Window {
    MathJax: any
  }
}

// ErrorBoundary：防止单题渲染错误拖垮整页
class ErrorBoundary extends React.Component<{ children: React.ReactNode; fallback?: React.ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  componentDidCatch(error: Error, info: any) {
    console.error('Question render error:', error, info)
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback || <div style={{ padding: 16, color: '#c33', border: '1px solid #fcc', borderRadius: 8, marginBottom: 12, background: '#fee' }}>该题目渲染出错，请检查数据</div>
    }
    return this.props.children
  }
}

// 预处理 LaTeX 代码，转换不支持的宏
// questionType: 题型，用于决定 \item 的转换格式
function preprocessLatex(latex: string, questionType?: string): string {
  if (!latex || typeof latex !== 'string') return ''
  // 去重：相同的 \img{key} 只保留第一次出现（防止同一图片渲染多次）
  // 同时支持 \img{key} 和 \img[key] 两种写法，并处理未闭合的残片
  const seenImgs = new Set<string>()
  latex = latex.replace(/\\img[\{\[]\s*([^\}\]\s]+)\s*[\}\]]?/g, (match, key) => {
    if (seenImgs.has(key)) return ''
    seenImgs.add(key)
    return match
  })
  let optionIndex = 0
  const optionLabels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  // 放宽解答题判断：支持 '解答'、'解答题'、包含 '解答' 的字符串
  const isSolution = questionType === '解答' || questionType === '解答题' || (questionType?.includes('解答') ?? false)

  // \item 替换规则：选择题用 A.B.C.D.，解答题用 (1)(2)...（半角括号，和常见试卷一致）
  const itemReplacer = (): string => {
    const label = isSolution
      ? `(${optionIndex + 1}) `
      : `${optionLabels[optionIndex] || (optionIndex + '.')}. `
    optionIndex++
    return `\n${label}`
  }

  return latex
    // 移除 exam/文档类的环境
    .replace(/\\begin\{choices\}/g, '')
    .replace(/\\end\{choices\}/g, '')
    .replace(/\\begin\{task\}/g, '')
    .replace(/\\end\{task\}/g, '')
    .replace(/\\begin\{solution\}/g, '')
    .replace(/\\end\{solution\}/g, '')
    .replace(/\\begin\{answer\}/g, '')
    .replace(/\\end\{answer\}/g, '')
    // 处理 \item 命令，根据题型转换
    .replace(/\\item\s*/g, itemReplacer)
    // 将 \includegraphics 转换为 \img{path}，让预览能显示占位符或实际图片
    .replace(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g, '\\img{$1}')
    // 转换 \paren{} 为 ()，括号内内容直接保留
    .replace(/\\paren\{([^}]*)\}/g, '($1)')
    // 转换 \sqpar{} 为 []，括号内内容直接保留
    .replace(/\\sqpar\{([^}]*)\}/g, '[$1]')
    // 转换 \abs{} 为 | |（用\text渲染）
    .replace(/\\abs\{([^}]*)\}/g, '|$1|')
    // 转换 \floor{} 为 ⌊ ⌋
    .replace(/\\floor\{([^}]*)\}/g, '⌊$1⌋')
    // 转换 \ceil{} 为 ⌈ ⌉
    .replace(/\\ceil\{([^}]*)\}/g, '⌈$1⌉')
    // 转换常见数学宏
    .replace(/\\RR/g, '\\mathbb{R}')
    .replace(/\\NN/g, '\\mathbb{N}')
    .replace(/\\ZZ/g, '\\mathbb{Z}')
    .replace(/\\QQ/g, '\\mathbb{Q}')
    .replace(/\\CC/g, '\\mathbb{C}')
    // 转换 \grad 为 ∇
    .replace(/\\grad/g, '\\nabla')
    // 移除 \def 定义（预览时不支持）
    .replace(/\\def\\[^\\]+\\{[^}]*\}/g, '')
    // 移除 \newcommand（预览时不支持）
    .replace(/\\newcommand\\[^\\]+\[[0-9]+\]\{[^}]*\}/g, '')
    // 转换 \fillin{答案} 为横线（exam 文档类命令）
    .replace(/\\fillin(\[[^\]]*\])?\{([^}]*)\}/g, '\\underline{\\qquad}')
    // 转换 \underline{\hspace{...}} → \underline{\qquad}（MathJax 兼容）
    .replace(/\\underline\{\\hspace\*?\{[^}]*\}\}/g, '\\underline{\\qquad}')
    // 转换空 \underline{} → \underline{\qquad}（cleanLatexArtifacts 剥离 \hspace 后可能出现）
    .replace(/\\underline\{\}/g, '\\underline{\\qquad}')
}

/**
 * 检测并提取 content 中的 A. / B. / C. / D. 格式选项行
 * 返回：{ cleanedContent: 去掉选项行后的内容, abcdOptions: 按 A→D 顺序提取的选项文本数组 }
 * 只处理“行首为 A. / B. / C. / D. ”的格式，不会误伤题干里的 A.（如 "点 A." 不是选项）
 */
function extractAbcdOptions(content: string): { cleanedContent: string; abcdOptions: string[] } {
  const lines = content.split('\n')
  const abcdOptions: string[] = []
  const cleanedLines: string[] = []
  // 行首可选空白后紧跟 A. B. C. D.（注意 D 后面有个点）
  const abcdRe = /^\s*([A-D])\.\s*(.*)$/
  for (const line of lines) {
    const m = line.match(abcdRe)
    if (m) {
      const letter = m[1]
      const text = m[2].trim()
      const idx = letter.charCodeAt(0) - 65 // A=0, B=1, C=2, D=3
      abcdOptions[idx] = text
    } else {
      cleanedLines.push(line)
    }
  }
  // 只取连续的 A→D，遇到空位就截断
  const validOptions: string[] = []
  for (let i = 0; i < 4; i++) {
    if (abcdOptions[i] !== undefined) {
      validOptions.push(abcdOptions[i])
    } else {
      break
    }
  }
  return {
    cleanedContent: cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    abcdOptions: validOptions
  }
}

// 将 LaTeX 表格语法转换为 HTML 表格（MathJax 不支持 tabular 环境）
function convertLatexTables(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let tableGroup: string[] = []

  const flushTable = () => {
    if (tableGroup.length === 0) return
    const dataRows = tableGroup
      .map(l => l.trim())
      .filter(l => l.includes('&') && !l.includes('\\hline'))
      .map(l => l.replace(/\\\\$/, '').replace(/\\\\\\hline$/, '').trim())

    if (dataRows.length === 0) {
      result.push(...tableGroup)
    } else {
      let html = '<table style="border-collapse:collapse;margin:12px 0;font-size:14px;">'
      dataRows.forEach(row => {
        const cells = row.split('&').map(c => c.trim())
        html += '<tr>'
        cells.forEach(cell => {
          html += `<td style="border:1px solid #ccc;padding:6px 12px;text-align:center;">${cell}</td>`
        })
        html += '</tr>'
      })
      html += '</table>'
      result.push(html)
    }
    tableGroup = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const isTableLine = trimmed.includes('&') || trimmed.includes('\\hline') || /^\\\\/.test(trimmed)

    if (isTableLine && !trimmed.includes('\\begin') && !trimmed.includes('\\end')) {
      tableGroup.push(line)
    } else {
      flushTable()
      result.push(line)
    }
  }
  flushTable()
  return result.join('\n')
}

// 为未包裹的原始 LaTeX 数学内容添加 \( ... \) 或 \[...\] 定界符
// 用于修复 analysis/answerContent 等字段中缺少数学模式定界符的问题
function ensureMathDelimiters(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let displayGroup: string[] = []

  const flushDisplayGroup = () => {
    if (displayGroup.length === 0) return
    if (displayGroup.length === 1) {
      result.push(`\\[${displayGroup[0]}\\]`)
    } else {
      const hasAlignment = displayGroup.some(l => /&/.test(l))
      if (hasAlignment) {
        result.push(`\\[\\begin{aligned}\n${displayGroup.join('\n')}\n\\end{aligned}\\]`)
      } else {
        result.push(`\\[${displayGroup.join(' \\\\\\n')}\\]`)
      }
    }
    displayGroup = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    // 空行或已有 HTML 标签的行直接保留
    if (!trimmed || /<[a-z][^>]*>/i.test(trimmed)) {
      flushDisplayGroup()
      result.push(line)
      continue
    }

    // 已有数学模式定界符的行直接保留
    if ((trimmed.startsWith('\\(') && trimmed.endsWith('\\)')) ||
        (trimmed.startsWith('\\[') && trimmed.endsWith('\\]')) ||
        (trimmed.startsWith('$$') && trimmed.endsWith('$$'))) {
      flushDisplayGroup()
      result.push(line)
      continue
    }

    // 行内已包含 \( ... \) 或 \[...\] 的不再整体包裹
    if (/\\\\\(/.test(trimmed) && /\\\\\)/.test(trimmed)) {
      flushDisplayGroup()
      result.push(line)
      continue
    }
    if (/\\\\\[/.test(trimmed) && /\\\\\]/.test(trimmed)) {
      flushDisplayGroup()
      result.push(line)
      continue
    }

    // ⚠️ 关键修复：行内已有 $...$ 内联数学分隔符 → 直接保留（MathJax 原生处理）
    const dollarCount = (trimmed.match(/\$/g) || []).length;
    if (dollarCount >= 2 && dollarCount % 2 === 0) {
      flushDisplayGroup()
      result.push(line)
      continue
    }

    // 检测是否包含原始 LaTeX 数学命令
    const hasMathCommand = /\\\\(because|therefore|frac|sqrt|sin|cos|tan|alpha|beta|gamma|delta|pi|cdot|left|right|geq|leq|neq|pm|times|overrightarrow|vec|mathbf|mathbb|text|tfrac|dfrac|sum|prod|int|lim|infty|partial|nabla|overline|underline|bar|hat|tilde|dot|ddot|quad|qquad)/.test(trimmed)

    if (!hasMathCommand) {
      flushDisplayGroup()
      result.push(line)
      continue
    }

    const hasAlignment = /&/.test(trimmed)
    const hasDisplayEnv = /\\\\begin\{(aligned|cases|matrix|bmatrix|pmatrix|array|gather|align|alignat|flalign|multline)\}/.test(trimmed)
    const hasLineBreak = /\\\\\\\\/.test(trimmed)

    if (hasDisplayEnv || hasAlignment || hasLineBreak) {
      displayGroup.push(trimmed)
    } else {
      flushDisplayGroup()
      result.push(`\\(${trimmed}\\)`)
    }
  }

  flushDisplayGroup()
  return result.join('\n')
}

// MathJax 预览组件 —— 比 KaTeX 更强大的 LaTeX 渲染
// MathJax 3 支持几乎所有标准 LaTeX 命令：\sqrt, \overrightarrow, \vec, \frac 等
function MathJaxPreview({ latex, imageUrls, questionType, style }: {
  latex: string
  imageUrls: Map<string, string>
  questionType?: string
  style?: React.CSSProperties
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  // 等待 MathJax 加载完成
  useEffect(() => {
    let timer: number
    const checkReady = () => {
      if (window.MathJax && window.MathJax.typesetPromise) {
        setReady(true)
      } else {
        timer = window.setTimeout(checkReady, 200)
      }
    }
    checkReady()
    return () => clearTimeout(timer)
  }, [])

  // 渲染内容
  useEffect(() => {
    if (!containerRef.current || !ready) return
    if (!latex || typeof latex !== 'string') {
      containerRef.current.innerHTML = '<p style="color:#999">（无内容）</p>'
      return
    }

    try {
    // 预处理 LaTeX
    let processed = preprocessLatex(latex, questionType)
    // 转换表格语法为 HTML 表格（MathJax 不支持 tabular）
    processed = convertLatexTables(processed)
    // 为未包裹的原始 LaTeX 数学内容添加定界符
    processed = ensureMathDelimiters(processed)

    // 处理图片引用 \img{key}（在 MathJax typeset 之前插入 HTML img 标签）
    // 按用户要求：图片在题目后面，左侧显示，占页面宽度的 30%
    const renderedImgs = new Set<string>()
    processed = processed.replace(/\\img[\{\[]\s*([^\}\]\s]+)\s*[\}\]]?/g, (_, key) => {
      if (renderedImgs.has(key)) return '' // 同一 key 只渲染一次
      renderedImgs.add(key)
      let url = imageUrls.get(key)
      if (!url) {
        // 回退1：key 本身是路径（如 图片/17.png），提取 basename 在 imageUrls 中查找
        const basename = key.replace(/^.*[\\/]/, '')
        if (basename !== key) {
          url = imageUrls.get(basename)
          // 也尝试遍历 imageUrls 找到 basename 匹配的值
          if (!url) {
            for (const [k, v] of imageUrls) {
              if (k === basename || k.endsWith('/' + basename) || v.endsWith('/' + basename)) {
                url = v; break;
              }
            }
          }
        }
        // 回退2：key 有图片扩展名，直接构造 URL
        if (!url) {
          const fallbackExt = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.eps'].find(ext => key.toLowerCase().endsWith(ext))
          if (fallbackExt) {
            // 优先用 basename 构造 URL（去掉图片/ 等目录前缀）
            url = `/uploads/images/${basename || key}`
          }
        }
      }
      if (url) {
        const fullUrl = url.startsWith('http') ? url : `${API}${url}`
        // 用 nextElementSibling 避免文本节点干扰；加 min-height 防止图片加载前/失败后高度塌陷
        // onerror 做防御：先隐藏自己，再尝试显示提示语（容错 nextElementSibling 不存在的情况）
        return `<div style="display:block;min-height:60px;"><img src="${fullUrl}" alt="diagram" onerror="this.style.display='none';var s=this.nextElementSibling;if(s)s.style.display='block';" style="display:block;max-width:150px;height:auto;margin:12px 0;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);" /><span style="display:none;color:#e74c3c;font-size:12px;padding:8px 0;">[图片: ${key} 未找到]</span></div>`
      }
      return `<span style="color:#e74c3c;font-size:12px;">[图片: ${key} 未找到]</span>`
    })

    // 处理 \underline{\qquad} / \underline{内容} —— MathJax 渲染不稳定时降级为 HTML
    // 先处理 \underline{\qquad} 和 \underline{\hspace*{...}}（已由 preprocessLatex 标准化）
    processed = processed.replace(/\\underline\{\\qquad\}/g, '<span class="mjx-underline" style="display:inline-block;width:3em;border-bottom:1.5px solid currentColor;"></span>')
    processed = processed.replace(/\\underline\{\\hspace\*?\{[^}]*\}\}/g, '<span class="mjx-underline" style="display:inline-block;width:3em;border-bottom:1.5px solid currentColor;"></span>')
    processed = processed.replace(/\\underline\{\s*\}/g, '<span class="mjx-underline" style="display:inline-block;width:3em;border-bottom:1.5px solid currentColor;"></span>')
    // 有内容的 \underline{text} 保留给 MathJax 渲染（如 \underline{a+b}）
    // 但 \underline{\text{...}} 已在上一步被 preprocessLatex 标准化

    // 换行处理（保留段落结构）
    processed = processed.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')
    if (!processed.startsWith('<p>')) processed = `<p>${processed}</p>`

    // 写入 DOM
    containerRef.current.innerHTML = processed

    // 调用 MathJax 渲染数学公式
    window.MathJax.typesetPromise([containerRef.current]).catch((err: any) => {
      console.error('MathJax typeset error:', err)
    })
    } catch (err: any) {
      console.error('MathJaxPreview render error:', err)
      if (containerRef.current) {
        containerRef.current.innerHTML = `<p style="color:#c33">[渲染错误: ${err.message || 'unknown'}]</p>`
      }
    }
  }, [latex, imageUrls, questionType, ready])

  if (!ready) {
    return <div style={{ ...style, color: '#999', fontSize: 13 }}>正在加载 MathJax...</div>
  }

  return <div ref={containerRef} style={style} />
}

// 内联 MathJax 渲染组件（用于选项等短文本，可含行内数学公式）
function MathJaxInline({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let t: number
    const check = () => {
      if (window.MathJax?.typesetPromise) { setReady(true); return }
      t = window.setTimeout(check, 200)
    }
    check()
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!ref.current || !ready) return
    if (text === undefined || text === null) {
      ref.current.textContent = ''
      return
    }
    try {
      // 调用 ensureMathDelimiters 包裹未定界的 LaTeX 命令（如 \sqrt{5} → \(\sqrt{5}\)）
      // 否则 MathJax 只识别 \(...\) / $...$ / $$...$$ 定界的公式
      const delimited = ensureMathDelimiters(text)
      ref.current.textContent = delimited
      window.MathJax.typesetPromise([ref.current]).catch(console.error)
    } catch (err) {
      console.error('MathJaxInline render error:', err)
    }
  }, [text, ready])

  if (!ready) return <span>{text}</span>
  return <span ref={ref}></span>
}

// 知识点分类类型
interface Category {
  id: string
  name: string
  children?: Category[]
}

// 试题类型
interface Question {
  id: string
  title: string
  content: string
  answerContent: string
  analysis: string
  options?: string[]
  answer?: string
  difficulty: string
  type: string
  grade: string
  categoryId: string
  categoryName: string
  tags: string[]
  source: string
  images: Record<string, string>
  createdAt: string
}

export default function App() {
  // Auth
  const { user, signOut } = useAuth()

  // 页面状态
  const [activeTab, setActiveTab] = useState<'bank' | 'editor' | 'basket' | 'composer' | 'import' | 'papers' | 'about' | 'pdf-batch'>('bank')

  // 数据状态
  const [categories, setCategories] = useState<Category[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [basket, setBasket] = useState<string[]>([])
  
  // 筛选状态
  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('all')
  const [selectedType, setSelectedType] = useState<string>('all')
  const [selectedGrade, setSelectedGrade] = useState<string>('all')
  const [searchKeyword, setSearchKeyword] = useState('')
  
  // 编辑器状态
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editAnalysis, setEditAnalysis] = useState('')
  const [editOptions, setEditOptions] = useState<string[]>(['', '', '', ''])
  const [editAnswer, setEditAnswer] = useState('')
  const [editDifficulty, setEditDifficulty] = useState('中')
  const [editType, setEditType] = useState('单选')
  const [editGrade, setEditGrade] = useState('高一')
  const [editCategory, setEditCategory] = useState('')
  const [editTags, setEditTags] = useState('')
  const [editSource, setEditSource] = useState('')
  const [editImages, setEditImages] = useState<Map<string, string>>(new Map())
  const [editTab, setEditTab] = useState<'content' | 'analysis'>('content')
  
  // 展开的分类
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())

  // 显示答案的题目
  const [showAnswerIds, setShowAnswerIds] = useState<Set<string>>(new Set())

  // AI 解析相关状态
  const [aiLoading, setAiLoading] = useState<string | null>(null)      // 正在请求的题目的 id
  const [aiPreviewQid, setAiPreviewQid] = useState<string | null>(null) // 正在预览 AI 解析的题目 id
  const [aiPreviewContent, setAiPreviewContent] = useState('')       // AI 生成的解析内容

  // 编辑区分栏拖拽状态
  const [editorSplitPct, setEditorSplitPct] = useState(50)
  const editorSplitRef = useRef<HTMLDivElement>(null)
  const isDraggingSplit = useRef(false)

  // 分页状态
  const [currentPage, setCurrentPage] = useState(1)
  const PAGE_SIZE = 10

  // PDF 预览弹窗
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // 批量录题状态
  const [batchStep, setBatchStep] = useState<1 | 2 | 3>(1)
  const [batchSessionId, setBatchSessionId] = useState('')
  const [batchTexFiles, setBatchTexFiles] = useState<any[]>([])
  const [batchSelectedFile, setBatchSelectedFile] = useState('')
  const [batchQuestions, setBatchQuestions] = useState<any[]>([])
  const [batchSelectedIds, setBatchSelectedIds] = useState<Set<string>>(new Set())
  const [batchCategory, setBatchCategory] = useState('')
  const [batchDifficulty, setBatchDifficulty] = useState('中')
  const [batchGrade, setBatchGrade] = useState('高一')
  const [batchUploading, setBatchUploading] = useState(false)
  const [batchParsing, setBatchParsing] = useState(false)
  const [batchSaving, setBatchSaving] = useState(false)
  // 批量录题预览：展开的题目 ID + 编辑后的内容
  const [expandedBatchQId, setExpandedBatchQId] = useState<string | null>(null)
  const [editedBatchContents, setEditedBatchContents] = useState<Record<string, string>>({})

  // 加载数据
  useEffect(() => {
    fetchCategories()
    fetchQuestions()
    fetchBasket()
  }, [])

  const fetchCategories = async () => {
    try {
      const res = await fetch(`${API}/api/categories`)
      const data = await res.json()
      setCategories(data)
    } catch (err) {
      console.error('加载分类失败:', err)
    }
  }

  // 规范化题目数据，防止损坏数据导致渲染崩溃
  const normalizeQuestion = (q: any) => ({
    ...q,
    images: q.images && typeof q.images === 'object' && !Array.isArray(q.images) ? q.images : {} as Record<string, string>,
    tags: Array.isArray(q.tags) ? q.tags.filter((t: any) => typeof t === 'string' && t.trim().length > 0) : [] as string[],
    source: typeof q.source === 'string' ? q.source : '',
    grade: q.grade || '',
    categoryId: q.categoryId || '',
    categoryName: q.categoryName || '',
  })

  const fetchQuestions = async () => {
    try {
      const params = new URLSearchParams()
      if (selectedCategory) params.append('category', selectedCategory)
      if (selectedDifficulty !== 'all') params.append('difficulty', selectedDifficulty)
      if (selectedType !== 'all') params.append('type', selectedType)
      if (selectedGrade !== 'all') params.append('grade', selectedGrade)
      if (searchKeyword) params.append('keyword', searchKeyword)
      
      const res = await fetch(`${API}/api/questions?${params}`)
      const data = await res.json()
      setQuestions(Array.isArray(data) ? data.map(normalizeQuestion) : [])
    } catch (err) {
      console.error('加载试题失败:', err)
    }
  }

  const fetchBasket = async () => {
    if (USE_SUPABASE_BASKET) {
      const ids = await supabaseFetchBasket()
      setBasket(ids)
      return
    }
    try {
      const res = await fetch(`${API}/api/basket`)
      const data = await res.json()
      setBasket(data.map((item: any) => item.questionId))
    } catch (err) {
      console.error('加载试卷篮失败:', err)
    }
  }

  // 筛选变化时重新加载并回到第一页
  useEffect(() => {
    setCurrentPage(1)
    fetchQuestions()
  }, [selectedCategory, selectedDifficulty, selectedType, selectedGrade])

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrentPage(1)
      fetchQuestions()
    }, 300)
    return () => clearTimeout(timer)
  }, [searchKeyword])

  // 切换分类展开
  const toggleCategory = (id: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 切换答案显示
  const toggleAnswer = (id: string) => {
    setShowAnswerIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // AI 解析：调用后端接口生成解析，然后展示预览对比
  const handleAiAnalysis = async (q: any) => {
    setAiLoading(q.id)
    setAiPreviewQid(q.id)
    setAiPreviewContent('')
    try {
      const res = await fetch(`${API}/api/ai-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: q.title,
          content: q.content,
          options: q.options || [],
          type: q.type
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '请求失败')
      setAiPreviewContent(data.analysis || '')
    } catch (err: any) {
      alert('AI 解析失败：' + (err.message || '未知错误'))
      setAiPreviewQid(null)
    } finally {
      setAiLoading(null)
    }
  }

  // 接受 AI 解析：将 AI 生成的内容写入题目，并刷新列表
  const handleAcceptAiAnalysis = async (qid: string) => {
    try {
      const q = questions.find((item: any) => item.id === qid)
      if (!q) return
      const body: any = { analysis: aiPreviewContent }
      // 只更新 analysis，不影响其他字段
      await fetch(`${API}/api/questions/${qid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      setAiPreviewQid(null)
      setAiPreviewContent('')
      fetchQuestions()
    } catch (err: any) {
      alert('保存失败：' + (err.message || '未知错误'))
    }
  }

  // 编辑区分栏拖拽
  const startSplitDrag = (e: React.MouseEvent) => {
    isDraggingSplit.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDraggingSplit.current || !editorSplitRef.current) return
      const rect = editorSplitRef.current.getBoundingClientRect()
      const pct = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100))
      setEditorSplitPct(pct)
    }
    const onUp = () => {
      isDraggingSplit.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 选择分类
  const handleSelectCategory = (id: string) => {
    setSelectedCategory(prev => prev === id ? '' : id)
    setCurrentPage(1)
  }

  // 分页数据
  const totalPages = Math.ceil(questions.length / PAGE_SIZE)
  const paginatedQuestions = questions.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  // 分页组件
  const Pagination = () => {
    if (totalPages <= 1) return null

    const getPageNumbers = () => {
      const pages: (number | string)[] = []
      if (totalPages <= 7) {
        for (let i = 1; i <= totalPages; i++) pages.push(i)
      } else {
        if (currentPage <= 4) {
          for (let i = 1; i <= 6; i++) pages.push(i)
          pages.push('...')
          pages.push(totalPages)
        } else if (currentPage >= totalPages - 3) {
          pages.push(1)
          pages.push('...')
          for (let i = totalPages - 5; i <= totalPages; i++) pages.push(i)
        } else {
          pages.push(1)
          pages.push('...')
          for (let i = currentPage - 2; i <= currentPage + 2; i++) pages.push(i)
          pages.push('...')
          pages.push(totalPages)
        }
      }
      return pages
    }

    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 20, padding: '12px 0' }}>
        <button
          onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
          disabled={currentPage === 1}
          style={{
            padding: '6px 12px',
            borderRadius: 4,
            border: '0.5px solid #ddd',
            background: currentPage === 1 ? '#f5f5f5' : '#fff',
            color: currentPage === 1 ? '#999' : '#333',
            cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
            fontSize: 13
          }}
        >
          &lt;
        </button>
        {getPageNumbers().map((page, i) => (
          <button
            key={i}
            onClick={() => typeof page === 'number' && setCurrentPage(page)}
            disabled={page === '...'}
            style={{
              padding: '6px 12px',
              borderRadius: 4,
              border: '0.5px solid #ddd',
              background: page === currentPage ? '#534AB7' : '#fff',
              color: page === currentPage ? '#fff' : page === '...' ? '#999' : '#333',
              cursor: page === '...' ? 'default' : 'pointer',
              fontSize: 13,
              minWidth: 36
            }}
          >
            {page}
          </button>
        ))}
        <button
          onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
          disabled={currentPage === totalPages}
          style={{
            padding: '6px 12px',
            borderRadius: 4,
            border: '0.5px solid #ddd',
            background: currentPage === totalPages ? '#f5f5f5' : '#fff',
            color: currentPage === totalPages ? '#999' : '#333',
            cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
            fontSize: 13
          }}
        >
          &gt;
        </button>
        <span style={{ fontSize: 13, color: '#666', marginLeft: 8 }}>
          跳至
        </span>
        <input
          type="number"
          min={1}
          max={totalPages}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const val = parseInt((e.target as HTMLInputElement).value)
              if (val >= 1 && val <= totalPages) setCurrentPage(val)
            }
          }}
          style={{
            width: 50,
            padding: '6px 8px',
            borderRadius: 4,
            border: '0.5px solid #ddd',
            fontSize: 13,
            textAlign: 'center'
          }}
        />
        <span style={{ fontSize: 13, color: '#666' }}>页</span>
      </div>
    )
  }

  // 添加到试卷篮
  const addToBasket = async (questionId: string) => {
    if (USE_SUPABASE_BASKET) {
      await supabaseAddToBasket(questionId)
      setBasket(prev => [...prev, questionId])
      return
    }
    try {
      await fetch(`${API}/api/basket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId })
      })
      setBasket(prev => [...prev, questionId])
    } catch (err) {
      alert('添加失败')
    }
  }

  // 从试卷篮移除
  const removeFromBasket = async (questionId: string) => {
    if (USE_SUPABASE_BASKET) {
      await supabaseRemoveFromBasket(questionId)
      setBasket(prev => prev.filter(id => id !== questionId))
      return
    }
    try {
      await fetch(`${API}/api/basket/${questionId}`, { method: 'DELETE' })
      setBasket(prev => prev.filter(id => id !== questionId))
    } catch (err) {
      alert('移除失败')
    }
  }

  // 上传图片
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append('image', file)
    try {
      const res = await fetch(`${API}/api/upload-image`, { method: 'POST', body: formData })
      const data = await res.json()
      if (data.url) {
        // ⚠️ 用服务器返回的 filename（去掉扩展名）作为 key，确保 \img{key} 和文件名一致
        const key = data.filename.replace(/\.[^.]+$/, '')
        setEditImages(prev => new Map(prev).set(key, data.url))
        setEditContent(prev => prev + `\\img{${key}}`)
      }
    } catch {
      alert('图片上传失败')
    }
    e.target.value = ''
  }

  // 保存试题
  const handleSaveQuestion = async () => {
    if (!editTitle.trim()) return alert('请填寫题目标题')
    if (!editContent.trim()) return alert('请填写题目内容')
    if (!editCategory) return alert('请选择知识点分类')

    // 选择题/多选题：选项来源优先级：content 末尾的 \item > editOptions
    // content 是用户直接编辑的主要界面，优先信任
    let finalContent = editContent.trim()
    let finalOptions: string[] | undefined
    if (editType === '单选' || editType === '多选') {
      // Step 0: 先把 A. / B. / C. / D. 格式统一转成 \item，方便后续统一处理
      const { cleanedContent: afterAbcd, abcdOptions } = extractAbcdOptions(finalContent)
      if (abcdOptions.length > 0) {
        finalContent = afterAbcd
        finalOptions = abcdOptions
      }
      // Step 1: 从 content 末尾的 \item 提取选项
      // ⚠️ 用第一个 \item 位置划分，而非最后一个；否则多选项时 stemHasItems 恒为 true
      const itemRe = /\\item\s*/g
      const allMatches = [...finalContent.matchAll(itemRe)]
      if (allMatches.length > 0) {
        const firstItemIdx = allMatches[0].index!
        const beforeItems = finalContent.slice(0, firstItemIdx)
        const itemsPart = finalContent.slice(firstItemIdx)
        const items = itemsPart.split(/\\item\s*/).filter(s => s.trim())
        // 提取最后一项中夹带的 \img{}（图片应放在选项之后，不能混入选项文本）
        // 同时处理 \img[key] 以及未闭合的残片
        const trailingImgs: string[] = []
        if (items.length > 0) {
          const lastIdx = items.length - 1
          const lastItem = items[lastIdx]
          const imgMatches = [...lastItem.matchAll(/\\img[\{\[]\s*[^\}\]\s]+\s*[\}\]]?/g)]
          imgMatches.forEach(m => trailingImgs.push(m[0]))
          if (imgMatches.length > 0) {
            items[lastIdx] = lastItem.replace(/\\img[\{\[][^\s]*/g, '').trim()
          }
        }
        const stemHasItems = /\\item\s*/.test(beforeItems)
        if (!stemHasItems && items.length > 0) {
          finalContent = beforeItems.trim()
          // 把末尾的 \img{} 放回 content 最后（选项之后）
          if (trailingImgs.length > 0) {
            finalContent += '\n' + trailingImgs.join('\n')
          }
          // 与之前提取的 A.B.C.D. 选项合并
          const merged = [...(finalOptions || [])]
          items.forEach((item, i) => {
            const cleanItem = item.replace(/\\img[\{\[][^\s]*/g, '').trim()
            if (!merged[i] || !merged[i].trim()) merged[i] = cleanItem
          })
          finalOptions = merged.filter(Boolean)
        }
      }
      // fallback：content 里没有 \item 时，用内联编辑框的 editOptions
      if (!finalOptions || finalOptions.length === 0) {
        const validEditOptions = editOptions.filter(o => o.trim())
        if (validEditOptions.length > 0) {
          finalOptions = validEditOptions
        }
      }
      // ⚠️ 清理 content 中的所有 \item 残留和 LaTeX 环境碎片
      finalContent = finalContent.replace(/\\item\s*[^\n]*/g, '')
      finalContent = finalContent.replace(/\\begin\{minipage\}[\s\S]*?\\end\{minipage\}/g, '')
      finalContent = finalContent.replace(/\\begin\{minipage\}[\s\S]*$/g, '')
      finalContent = finalContent.replace(/\\end\{minipage\}/g, '')
      finalContent = finalContent.replace(/\n{3,}/g, '\n\n').trim()
      // 如果内容里有 \begin{array}...\end{array} 块且我们有 editOptions，说明用户改了选项，
      // 需要把数组块也清掉，否则前端显示时数组块里的旧选项会取代新选项
      if (finalOptions && finalOptions.length > 0 && /\\end\{array\}/.test(finalContent)) {
        finalContent = finalContent.replace(/\\begin\{array\}[\s\S]*?\\end\{array\}\s*/g, '')
        finalContent = finalContent.replace(/\n{3,}/g, '\n\n').trim()
      }
    }

    const questionData = {
      title: editTitle,
      content: finalContent,
      answerContent: '',  // 答案已合并到解析，不再单独存储
      analysis: editAnalysis,
      options: finalOptions && finalOptions.length > 0 ? finalOptions : undefined,
      answer: editAnswer,
      difficulty: editDifficulty,
      type: editType,
      grade: editGrade,
      categoryId: editCategory,
      categoryName: categories.flatMap(c => [c, ...(c.children || [])]).find(c => c.id === editCategory)?.name || '',
      tags: editTags.split(/[,，]/).map(t => t.trim().replace(/[\n\r]+/g, '')).filter(t => t.length > 0),
      source: editSource,
      images: Object.fromEntries(editImages)
    }

    try {
      if (editingQuestion) {
        await fetch(`${API}/api/questions/${editingQuestion.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(questionData)
        })
      } else {
        await fetch(`${API}/api/questions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(questionData)
        })
      }
      
      // 重置表单
      setEditTitle('')
      setEditContent('')
      
      setEditAnalysis('')
      setEditOptions(['', '', '', ''])
      setEditAnswer('')
      setEditDifficulty('中')
      setEditType('单选')
      setEditGrade('高一')
      setEditCategory('')
      setEditTags('')
      setEditSource('')
      setEditImages(new Map())
      setEditingQuestion(null)
      setEditTab('content')
      
      fetchQuestions()
      alert('保存成功！')
    } catch (err) {
      alert('保存失败')
    }
  }

  // 编辑试题
  const handleEdit = (q: Question) => {
    setEditingQuestion(q)
    setEditTitle(q.title)
    // 选择题/多选题：把选项追加到题目内容末尾（\item 格式），方便在编辑器中看到
    // ⚠️ 先清理 content 中可能残留的旧选项和 LaTeX 环境碎片，再加新选项
    let cleanContent = q.content
    const isChoice = q.type === '单选' || q.type === '多选'
    let rawOpts: string[] = q.options || []

    if (isChoice) {
      // 如果 options 数组为空但 content 里有 \item，从 content 提取选项
      if (rawOpts.length === 0 || !rawOpts.some(o => o.trim())) {
        const itemMatches = cleanContent.match(/\\item\s*([^\n]*)/g)
        if (itemMatches && itemMatches.length > 0) {
          rawOpts = itemMatches.map(m => m.replace(/\\item\s*/, '').trim()).filter(Boolean)
        }
      }
      // 同时检测 A. / B. / C. / D. 格式选项，合并到 rawOpts
      const { cleanedContent: afterAbcd, abcdOptions } = extractAbcdOptions(cleanContent)
      if (abcdOptions.length > 0) {
        cleanContent = afterAbcd
        // 若之前已有 options，用 A.B.C.D. 补充缺失项
        const combined = [...rawOpts]
        abcdOptions.forEach((opt, i) => {
          if (!combined[i] || !combined[i].trim()) combined[i] = opt
        })
        rawOpts = combined.filter(o => o.trim())
      }
      // 1. 删除所有 \item 行（旧选项残留）
      cleanContent = cleanContent.replace(/\\item\s*[^\n]*/g, '')
      // 2. 删除 LaTeX 环境残留碎片（\begin{minipage}、\end{minipage} 等）
      cleanContent = cleanContent.replace(/\\begin\{minipage\}[\s\S]*?\\end\{minipage\}/g, '')
      cleanContent = cleanContent.replace(/\\begin\{minipage\}[\s\S]*$/g, '')
      cleanContent = cleanContent.replace(/\\end\{minipage\}/g, '')
      // 3. 清除多余空行
      cleanContent = cleanContent.replace(/\n{3,}/g, '\n\n').trim()
    }

    // 清理选项中可能残留的图片标签（防止历史脏数据进入编辑区）
    rawOpts = rawOpts.map(o => o.replace(/\\img[\{\[][^\s]*/g, '').trim()).filter(Boolean)

    // 如果内容已用 \begin{array} 等 LaTeX 排版包含选项，不再追回 \item，避免重复
    const hasOwnArrayOpts = /\\end\{array\}/.test(cleanContent)
    let fullContent = cleanContent
    if (isChoice && rawOpts.length > 0 && rawOpts.some((o: string) => o.trim()) && !hasOwnArrayOpts) {
      const optSuffix = rawOpts.map((o: string) => `\\item ${o}`).join('\n')
      fullContent = cleanContent + '\n' + optSuffix
    }
    setEditContent(fullContent)

    setEditAnalysis(q.analysis || q.answerContent || '')
    // options 编辑区不再单独维护，只用于 save 时提取
    const paddedOpts = [...rawOpts]
    while (paddedOpts.length < 4) paddedOpts.push('')
    setEditOptions(paddedOpts)
    setEditAnswer(q.answer || '')
    setEditDifficulty(q.difficulty)
    setEditType(q.type)
    setEditGrade(q.grade)
    setEditCategory(q.categoryId)
    setEditTags(q.tags?.join(', ') || '')
    setEditSource(q.source || '')
    setEditImages(new Map(Object.entries(q.images || {})))
    setEditTab('content')
    setActiveTab('editor')
  }

  // 删除试题
  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这道题吗？')) return
    try {
      await fetch(`${API}/api/questions/${id}`, { method: 'DELETE' })
      fetchQuestions()
      setBasket(prev => prev.filter(bid => bid !== id))
    } catch (err) {
      alert('删除失败')
    }
  }

  // 生成试卷
  // 预览 PDF（调用 xelatex 编译，在弹窗内 iframe 显示）
  const handlePreviewPDF = async (includeAnswer: boolean, includeAnalysis: boolean) => {
    if (basket.length === 0) return alert('旧版组卷为空，请先添加题目')
    setPreviewLoading(true)
    try {
      const res = await fetch(`${API}/api/generate-paper?preview=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '数学试卷',
          questionIds: basket,
          includeAnswer,
          includeAnalysis,
          format: 'pdf'
        })
      })
      const contentType = res.headers.get('content-type')
      if (contentType && contentType.includes('application/json')) {
        const data = await res.json()
        setPreviewLoading(false)
        return alert('预览失败：' + data.error)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      setPreviewUrl(url)
      setPreviewLoading(false)
    } catch (err) {
      setPreviewLoading(false)
      alert('预览失败')
    }
  }

  // 导出试卷（支持 ZIP 源码包 或 PDF）
  const handleGeneratePaper = async (includeAnswer: boolean, includeAnalysis: boolean, format: 'zip' | 'pdf' = 'zip', paperSize: 'a4' | 'b4' = 'b4') => {
    if (basket.length === 0) return alert('旧版组卷为空，请先添加题目')

    try {
      const sizeSuffix = paperSize === 'a4' ? '_A4' : '';
      const suffix = includeAnswer ? (includeAnalysis ? '教师版含解析' : '_教师版') : '_学生版';
      const filename = `数学试卷${suffix}${sizeSuffix}.${format === 'pdf' ? 'pdf' : 'zip'}`

      const res = await fetch(`${API}/api/generate-paper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '数学试卷',
          questionIds: basket,
          includeAnswer,
          includeAnalysis,
          format,
          paperSize
        })
      })

      if (!res.ok) {
        const errorText = await res.text()
        throw new Error(errorText || '服务器错误')
      }

      const contentType = res.headers.get('content-type')
      if (contentType && contentType.includes('application/json')) {
        const data = await res.json()
        throw new Error(data.error || '未知错误')
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)

      alert(`${format === 'pdf' ? 'PDF' : 'LaTeX 源码'}下载成功！共 ${basket.length} 道题`)
    } catch (err: any) {
      alert('导出失败：' + (err.message || '未知错误'))
    }
  }

  // 清空试卷篮
  const handleClearBasket = async () => {
    if (!confirm('确定要清空旧版组卷吗？')) return
    if (USE_SUPABASE_BASKET) {
      await supabaseClearBasket()
      setBasket([])
      return
    }
    try {
      await fetch(`${API}/api/basket`, { method: 'DELETE' })
      setBasket([])
    } catch (err) {
      alert('清空失败')
    }
  }

  // 批量录题：上传 ZIP
  const handleBatchUpload = async (file: File) => {
    setBatchUploading(true)
    try {
      const formData = new FormData()
      formData.append('zipfile', file)
      const res = await fetch(`${API}/api/batch-import/upload-zip`, { method: 'POST', body: formData })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      setBatchSessionId(data.sessionId)
      setBatchTexFiles(data.texFiles)
      setBatchStep(2)
    } catch (err: any) {
      alert('上传失败：' + (err.message || '未知错误'))
    } finally {
      setBatchUploading(false)
    }
  }

  // 批量录题：解析 .tex 文件
  const handleBatchParse = async (relativePath: string) => {
    setBatchSelectedFile(relativePath)
    setBatchParsing(true)
    setBatchQuestions([])
    setBatchSelectedIds(new Set())
    try {
      const res = await fetch(`${API}/api/batch-import/parse-tex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: batchSessionId, relativePath })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      setBatchQuestions(data.questions || [])
    } catch (err: any) {
      alert('解析失败：' + (err.message || '未知错误'))
      setBatchSelectedFile('')
    } finally {
      setBatchParsing(false)
    }
  }

  // 批量录题：保存
  const handleBatchSave = async () => {
    if (!batchCategory) return alert('请选择知识点分类')
    if (batchSelectedIds.size === 0) return alert('请至少选择一道题')

    setBatchSaving(true)
    try {
      const selected = batchQuestions
        .filter((q: any) => batchSelectedIds.has(q._tempId))
        .map((q: any) => ({
          ...q,
          // 如果用户编辑了内容，使用编辑后的版本
          content: editedBatchContents[q._tempId] ?? q.content,
          categoryId: batchCategory,
          categoryName: categories.flatMap(c => [c, ...(c.children || [])]).find(c => c.id === batchCategory)?.name || '',
          difficulty: batchDifficulty,
          grade: batchGrade,
        }))

      const res = await fetch(`${API}/api/batch-import/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: selected })
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)

      alert(`成功保存 ${data.savedCount} 道题！`)
      // 重置
      setBatchStep(1)
      setBatchSessionId('')
      setBatchTexFiles([])
      setBatchSelectedFile('')
      setBatchQuestions([])
      setBatchSelectedIds(new Set())
      setBatchCategory('')
      fetchQuestions()
    } catch (err: any) {
      alert('保存失败：' + (err.message || '未知错误'))
    } finally {
      setBatchSaving(false)
    }
  }

  // 获取试卷篮中的题目
  const basketQuestions = questions.filter(q => basket.includes(q.id))

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f0', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* 顶部导航 */}
      <header style={{ background: '#fff', borderBottom: '0.5px solid #e8e8e4', padding: '0 24px', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 20, color: '#534AB7', fontWeight: 600 }}>∑</span>
            <span style={{ fontSize: 16, fontWeight: 600, color: '#333' }}>数学试题库</span>
            {user && (
              <button
                onClick={async () => {
                  const { data: { session } } = await supabase.auth.getSession()
                  const base = 'https://classmate-map.vercel.app'
                  const hash = session
                    ? `access_token=${session.access_token}&refresh_token=${session.refresh_token || ''}`
                    : ''
                  window.open(`${base}#${hash}`, '_blank')
                }}
                style={{
                  marginLeft: 8, padding: '3px 10px', borderRadius: 6,
                  border: '0.5px solid #fdba74', background: '#fff7ed',
                  color: '#f97316', fontSize: 12, cursor: 'pointer',
                }}
              >蹭饭图</button>
            )}
            {user && (
              <button
                onClick={signOut}
                style={{
                  marginLeft: 12, padding: '4px 12px', borderRadius: 6,
                  border: '0.5px solid #ddd', background: 'transparent',
                  color: '#999', fontSize: 12, cursor: 'pointer',
                }}
              >退出</button>
            )}
          </div>
          <nav style={{ display: 'flex', gap: 4 }}>
            {[
              { key: 'bank', label: '试题库' },
              { key: 'composer', label: '✨ 新版组卷' },
              { key: 'basket', label: `旧版组卷 (${basket.length})` },
              { key: 'about', label: '关于' }
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key as any)}
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: 'none',
                  background: activeTab === tab.key ? '#534AB7' : 'transparent',
                  color: activeTab === tab.key ? '#fff' : '#666',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 500
                }}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 1400, margin: '0 auto', padding: 20 }}>
        {/* ========== 试题库页面 ========== */}
        {activeTab === 'bank' && (
          <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20 }}>
            {/* 左侧分类树 */}
            <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 16, height: 'fit-content' }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12, color: '#333' }}>知识点分类</div>
              {categories.map(cat => (
                <div key={cat.id}>
                  <div
                    onClick={() => toggleCategory(cat.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 8px',
                      cursor: 'pointer',
                      borderRadius: 6,
                      background: selectedCategory === cat.id ? '#EEEDFE' : 'transparent',
                      color: selectedCategory === cat.id ? '#534AB7' : '#333',
                      fontWeight: 500,
                      fontSize: 13
                    }}
                  >
                    <span style={{ fontSize: 12, color: '#999' }}>{expandedCategories.has(cat.id) ? '−' : '+'}</span>
                    <span onClick={(e) => { e.stopPropagation(); handleSelectCategory(cat.id) }}>{cat.name}</span>
                  </div>
                  {expandedCategories.has(cat.id) && cat.children?.map(child => (
                    <div
                      key={child.id}
                      onClick={() => handleSelectCategory(child.id)}
                      style={{
                        padding: '4px 8px 4px 28px',
                        cursor: 'pointer',
                        borderRadius: 6,
                        background: selectedCategory === child.id ? '#EEEDFE' : 'transparent',
                        color: selectedCategory === child.id ? '#534AB7' : '#666',
                        fontSize: 13
                      }}
                    >
                      {child.name}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* 右侧内容 */}
            <div>
              {/* 筛选栏 */}
              <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 16, marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, color: '#666' }}>难度:</span>
                    {['all', '较易', '易', '中', '较难', '难'].map(d => (
                      <button
                        key={d}
                        onClick={() => setSelectedDifficulty(d)}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 12,
                          border: 'none',
                          background: selectedDifficulty === d ? '#534AB7' : '#f0f0ec',
                          color: selectedDifficulty === d ? '#fff' : '#666',
                          cursor: 'pointer',
                          fontSize: 12
                        }}
                      >
                        {d === 'all' ? '全部' : d}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, color: '#666' }}>题型:</span>
                    {['all', '单选', '多选', '填空', '解答'].map(t => (
                      <button
                        key={t}
                        onClick={() => setSelectedType(t)}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 12,
                          border: 'none',
                          background: selectedType === t ? '#534AB7' : '#f0f0ec',
                          color: selectedType === t ? '#fff' : '#666',
                          cursor: 'pointer',
                          fontSize: 12
                        }}
                      >
                        {t === 'all' ? '全部' : t}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, color: '#666' }}>年级:</span>
                    {['all', '高一', '高二', '高三'].map(g => (
                      <button
                        key={g}
                        onClick={() => setSelectedGrade(g)}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 12,
                          border: 'none',
                          background: selectedGrade === g ? '#534AB7' : '#f0f0ec',
                          color: selectedGrade === g ? '#fff' : '#666',
                          cursor: 'pointer',
                          fontSize: 12
                        }}
                      >
                        {g === 'all' ? '全部' : g}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  type="text"
                  placeholder="搜索题目内容、标签..."
                  value={searchKeyword}
                  onChange={e => setSearchKeyword(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 14px',
                    borderRadius: 8,
                    border: '0.5px solid #ddd',
                    fontSize: 14,
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              {/* 题目列表 */}
              <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <span style={{ fontSize: 13, color: '#666' }}>
                    共 <strong style={{ color: '#333' }}>{questions.length}</strong> 道题目
                    {totalPages > 1 && (
                      <span style={{ marginLeft: 8 }}>
                        第 <strong style={{ color: '#333' }}>{currentPage}</strong> / {totalPages} 页
                      </span>
                    )}
                  </span>
                </div>

                {questions.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
                    <div style={{ fontSize: 48, marginBottom: 16 }}>∅</div>
                    <div>暂无题目，点击"录入试题"添加</div>
                  </div>
                ) : (
                  paginatedQuestions.map((q, index) => (
                    <ErrorBoundary key={q.id} fallback={
                      <div style={{ padding: 16, color: '#c33', border: '1px solid #fcc', borderRadius: 8, marginBottom: 12, background: '#fee' }}>
                        <strong>题目 #{index + 1} 渲染出错</strong>（id: {q.id}）<br/>
                        <span style={{ fontSize: 12 }}>请检查该题数据是否损坏，或按 F12 查看控制台错误信息</span>
                      </div>
                    }>
                    <div style={{ border: '0.5px solid #e8e8e4', borderRadius: 8, padding: 16, marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 12, color: '#534AB7', fontWeight: 600 }}>#{(currentPage - 1) * PAGE_SIZE + index + 1}</span>
                          <span style={{ fontSize: 12, color: '#666', background: '#f0f0ec', padding: '2px 8px', borderRadius: 4 }}>{q.type}</span>
                          <span style={{ fontSize: 12, color: '#666' }}>{q.grade}</span>
                          <span style={{ fontSize: 12, color: '#e6a817' }}>{'★'.repeat(['较易', '易', '中', '较难', '难'].indexOf(q.difficulty) + 1)}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {(q.answer || q.answerContent || q.analysis) && (
                            <button
                              onClick={() => toggleAnswer(q.id)}
                              style={{
                                fontSize: 12,
                                padding: '4px 12px',
                                borderRadius: 4,
                                border: '0.5px solid #534AB7',
                                background: showAnswerIds.has(q.id) ? '#534AB7' : '#fff',
                                color: showAnswerIds.has(q.id) ? '#fff' : '#534AB7',
                                cursor: 'pointer'
                              }}
                            >
                              {showAnswerIds.has(q.id) ? '隐藏答案' : '显示答案'}
                            </button>
                          )}
                          <button
                            onClick={() => handleAiAnalysis(q)}
                            disabled={aiLoading === q.id}
                            style={{
                              fontSize: 12,
                              padding: '4px 12px',
                              borderRadius: 4,
                              border: '0.5px solid #f57c00',
                              background: aiLoading === q.id ? '#fff3e0' : '#fff',
                              color: '#f57c00',
                              cursor: aiLoading === q.id ? 'not-allowed' : 'pointer'
                            }}
                          >
                            {aiLoading === q.id ? 'AI 生成中...' : 'AI 解析'}
                          </button>
                          <button
                            onClick={() => basket.includes(q.id) ? removeFromBasket(q.id) : addToBasket(q.id)}
                            style={{
                              fontSize: 12,
                              padding: '4px 12px',
                              borderRadius: 4,
                              border: 'none',
                              background: basket.includes(q.id) ? '#e8f5e9' : '#534AB7',
                              color: basket.includes(q.id) ? '#2e7d32' : '#fff',
                              cursor: 'pointer'
                            }}
                          >
                            {basket.includes(q.id) ? '✓ 已添加' : '+ 加入试题篮'}
                          </button>
                          <button onClick={() => handleEdit(q)} style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, border: '0.5px solid #ddd', background: 'transparent', cursor: 'pointer' }}>编辑</button>
                          <button onClick={() => handleDelete(q.id)} style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, border: '0.5px solid #fcc', background: '#fee', color: '#c33', cursor: 'pointer' }}>删除</button>
                        </div>
                      </div>
                      {(() => {
                        // 若已通过 options 数组单独渲染选项，则从 content 中剥离 \item 行和 \img{}，避免重复显示
                        // \img{} 抽出来放到选项**后面**渲染，不在题目和选项之间
                        let displayContent = q.content
                        let trailingImgs = ''
                        if (q.options && q.options.length > 0) {
                          if (/\\item\s*/.test(displayContent)) {
                            const firstItemIdx = displayContent.search(/\\item\s*/)
                            const before = displayContent.slice(0, firstItemIdx)
                            if (!/\\item\s*/.test(before)) {
                              displayContent = before.trim()
                            }
                          }
                          const imgMatches = [...displayContent.matchAll(/\\img[\{\[]\s*[^\}\]\s]+\s*[\}\]]?/g)]
                          if (imgMatches.length > 0) {
                            trailingImgs = imgMatches.map(m => m[0]).join('\n')
                            displayContent = displayContent.replace(/\\img[\{\[][^\s]*/g, '').replace(/\n{3,}/g, '\n\n').trim()
                          }
                        }
                        return (
                          <>
                            <MathJaxPreview latex={displayContent} imageUrls={new Map(Object.entries(q.images || {}))} questionType={q.type} style={{ fontSize: 14, marginBottom: 8 }} />
                            {q.options && q.options.length > 0 && (
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13, color: '#666', marginTop: 8, marginBottom: 8 }}>
                                {q.options.map((opt, i) => (
                                  <div key={i}>{['A', 'B', 'C', 'D', 'E'][i]}. <MathJaxInline text={opt} /></div>
                                ))}
                              </div>
                            )}
                            {trailingImgs && (
                              <MathJaxPreview latex={trailingImgs} imageUrls={new Map(Object.entries(q.images || {}))} questionType={q.type} style={{ fontSize: 14 }} />
                            )}
                          </>
                        )
                      })()}
                      {/* 无 options 数组时保留原有展示 */}
                      {showAnswerIds.has(q.id) && (q.analysis || q.answer || q.answerContent) && (
                        <div style={{ marginTop: 12, padding: 12, background: '#f8f9fa', borderRadius: 6, borderLeft: '3px solid #534AB7' }}>
                          <div style={{ fontSize: 12, color: '#534AB7', fontWeight: 600, marginBottom: 6 }}>解析</div>
                          <MathJaxPreview latex={q.analysis || q.answerContent || q.answer || ''} imageUrls={new Map(Object.entries(q.images || {}))} questionType={q.type} style={{ fontSize: 13, color: '#555' }} />
                        </div>
                      )}

                      {/* AI 解析预览对比 */}
                      {aiPreviewQid === q.id && (
                        <div style={{ marginTop: 12, padding: 12, background: '#fff8e1', borderRadius: 6, borderLeft: '3px solid #f57c00' }}>
                          <div style={{ fontSize: 12, color: '#f57c00', fontWeight: 600, marginBottom: 6 }}>AI 解析预览</div>
                          <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>原有解析：</div>
                          <div style={{ marginBottom: 12, padding: 8, background: '#f5f5f5', borderRadius: 4 }}>
                            <MathJaxPreview latex={q.analysis || '(无)'} imageUrls={new Map(Object.entries(q.images || {}))} questionType={q.type} style={{ fontSize: 13 }} />
                          </div>
                          <div style={{ fontSize: 12, color: '#f57c00', marginBottom: 8 }}>AI 新解析：</div>
                          <div style={{ marginBottom: 12, maxHeight: 400, overflowY: 'auto', paddingRight: 4 }}>
                            {aiLoading === q.id ? (
                              <span style={{ fontSize: 13, color: '#999' }}>生成中...</span>
                            ) : (
                              <MathJaxPreview latex={aiPreviewContent} imageUrls={new Map(Object.entries(q.images || {}))} questionType={q.type} style={{ fontSize: 13, color: '#555' }} />
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              onClick={() => handleAcceptAiAnalysis(q.id)}
                              disabled={aiLoading === q.id || !aiPreviewContent}
                              style={{
                                fontSize: 12,
                                padding: '4px 12px',
                                borderRadius: 4,
                                border: 'none',
                                background: '#f57c00',
                                color: '#fff',
                                cursor: (!aiPreviewContent || aiLoading === q.id) ? 'not-allowed' : 'pointer'
                              }}
                            >使用 AI 解析</button>
                            <button
                              onClick={() => { setAiPreviewQid(null); setAiPreviewContent(''); }}
                              style={{
                                fontSize: 12,
                                padding: '4px 12px',
                                borderRadius: 4,
                                border: '0.5px solid #ddd',
                                background: '#fff',
                                color: '#666',
                                cursor: 'pointer'
                              }}
                            >保留原解析</button>
                          </div>
                        </div>
                      )}

                      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {q.tags?.map(tag => (
                          <span key={tag} style={{ fontSize: 11, color: '#534AB7', background: '#EEEDFE', padding: '2px 8px', borderRadius: 10 }}>{tag}</span>
                        ))}
                        {q.source && <span style={{ fontSize: 11, color: '#999' }}>来源: {q.source}</span>}
                      </div>
                    </div>
                    </ErrorBoundary>
                  ))
                )}
                <Pagination />
              </div>
            </div>
          </div>
        )}

        {/* ========== 录入试题页面 ========== */}
        {activeTab === 'editor' && (
          <div style={{ maxWidth: 1200, margin: '0 auto' }}>
            <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 24 }}>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20 }}>{editingQuestion ? '编辑试题' : '录入新试题'}</h2>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: '#555' }}>题目标题</label>
                  <input value={editTitle} onChange={e => setEditTitle(e.target.value)} placeholder="简短描述题目内容" style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: '#555' }}>知识点分类</label>
                  <select value={editCategory} onChange={e => setEditCategory(e.target.value)} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #ddd', fontSize: 14, boxSizing: 'border-box' }}>
                    <option value="">请选择分类</option>
                    {categories.map(cat => (
                      <optgroup key={cat.id} label={cat.name}>
                        <option value={cat.id}>{cat.name}</option>
                        {cat.children?.map(child => (
                          <option key={child.id} value={child.id}>　{child.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: '#555' }}>标签（用逗号分隔）</label>
                  <input value={editTags} onChange={e => setEditTags(e.target.value)} placeholder="如：诱导公式,图像变换" style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
                </div>
              </div>

              {/* 题型提示 */}
              <div style={{ marginBottom: 12, padding: '8px 12px', background: '#EEEDFE', borderRadius: 6, fontSize: 13, color: '#534AB7' }}>
                <strong>当前题型：</strong>{editType}
                {editType === '解答' && <span style={{ marginLeft: 8, color: '#666' }}>（\item 将显示为 (1)(2)... 格式）</span>}
                {(editType === '单选' || editType === '多选') && <span style={{ marginLeft: 8, color: '#666' }}>（\item 将显示为 A.B.C.D. 格式）</span>}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: '#555' }}>难度</label>
                  <select value={editDifficulty} onChange={e => setEditDifficulty(e.target.value)} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #ddd', fontSize: 14 }}>
                    {['较易', '易', '中', '较难', '难'].map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: '#555' }}>题型</label>
                  <select value={editType} onChange={e => setEditType(e.target.value)} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #ddd', fontSize: 14 }}>
                    {['单选', '多选', '填空', '解答'].map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: '#555' }}>年级</label>
                  <select value={editGrade} onChange={e => setEditGrade(e.target.value)} style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #ddd', fontSize: 14 }}>
                    {['高一', '高二', '高三'].map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: '#555' }}>来源</label>
                  <input value={editSource} onChange={e => setEditSource(e.target.value)} placeholder="如：2026年广西模拟" style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #ddd', fontSize: 14, boxSizing: 'border-box' }} />
                </div>
              </div>

              {/* LaTeX 编辑器 - 标签页形式 */}
              <div style={{ marginBottom: 16 }}>
                {/* 标签页导航 */}
                <div style={{ display: 'flex', gap: 4, borderBottom: '0.5px solid #e8e8e4', marginBottom: 16 }}>
                  {[
                    { key: 'content', label: '📝 题目内容' },
                    { key: 'analysis', label: '💡 解析内容' }
                  ].map(tab => (
                    <button
                      key={tab.key}
                      onClick={() => setEditTab(tab.key as any)}
                      style={{
                        padding: '10px 20px',
                        border: 'none',
                        borderBottom: editTab === tab.key ? '2px solid #534AB7' : '2px solid transparent',
                        background: 'transparent',
                        color: editTab === tab.key ? '#534AB7' : '#666',
                        cursor: 'pointer',
                        fontSize: 14,
                        fontWeight: editTab === tab.key ? 600 : 400,
                        marginBottom: -1
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                  <div style={{ flex: 1 }} />
                  <label style={{ padding: '6px 14px', borderRadius: 6, border: '0.5px solid #ddd', background: '#f9f9f9', cursor: 'pointer', fontSize: 12, alignSelf: 'center', marginBottom: 8 }}>
                    <input type="file" accept="image/*" onChange={handleImageUpload} style={{ display: 'none' }} />
                    🖼 上传图片
                  </label>
                </div>

                {/* 标签页内容 */}
                <div ref={editorSplitRef} style={{ display: 'flex', gap: 0, alignItems: 'stretch' }}>
                  {/* 左区：代码 */}
                  <div style={{ flex: `0 0 ${editorSplitPct}%`, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <label style={{ fontSize: 13, fontWeight: 500, color: '#555' }}>
                      {editTab === 'content' && '题目内容（LaTeX）'}
                        {editTab === 'analysis' && '解析内容（LaTeX）'}
                      </label>
                    </div>
                    <textarea
                      value={editTab === 'content' ? editContent : editAnalysis}
                      onChange={e => {
                        if (editTab === 'content') {
                          const newContent = e.target.value
                          setEditContent(newContent)
                          // 双向同步：content 中的 \item 选项 → editOptions
                          if (editType === '单选' || editType === '多选') {
                            const itemRe = /\\item\s*/g
                            const allMatches = [...newContent.matchAll(itemRe)]
                            if (allMatches.length > 0) {
                              const firstItemIdx = allMatches[0].index!
                              const beforeItems = newContent.slice(0, firstItemIdx)
                              const itemsPart = newContent.slice(firstItemIdx)
                              const stemHasItems = /\\item\s*/.test(beforeItems)
                              if (!stemHasItems) {
                                const items = itemsPart.split(/\\item\s*/).filter(s => s.trim()).map(s => s.trim())
                                // 去掉最后一项中夹带的 \img{}，避免图片混入选项
                                // 同时处理 \img[key] 以及未闭合的残片
                                if (items.length > 0) {
                                  const lastIdx = items.length - 1
                                  items[lastIdx] = items[lastIdx].replace(/\\img[\{\[][^\s]*/g, '').trim()
                                }
                                const cleanItems = items.filter(Boolean)
                                if (cleanItems.length > 0) {
                                  const padded = [...cleanItems]
                                  while (padded.length < 4) padded.push('')
                                  // 仅值不同时才更新，避免无效渲染
                                  const currentOpts = editOptions.filter(o => o.trim())
                                  if (JSON.stringify(cleanItems) !== JSON.stringify(currentOpts)) {
                                    setEditOptions(padded)
                                  }
                                }
                              }
                            }
                          }
                        }
                        else setEditAnalysis(e.target.value)
                      }}
                      placeholder={`输入 LaTeX 代码...\n\n行内公式: $...$ 或 \\(...\\)\n独立公式: $$...$$ 或 \\[...\\]\n图片引用: \\img{key}`}
                      rows={20}
                      style={{
                        width: '100%',
                        minHeight: 380,
                        padding: 12,
                        borderRadius: 8,
                        border: '0.5px solid #ddd',
                        fontSize: 14,
                        fontFamily: 'monospace',
                        lineHeight: 1.6,
                        resize: 'vertical',
                        boxSizing: 'border-box'
                      }}
                    />
                  </div>

                  {/* 可拖拽分隔条 */}
                  <div
                    onMouseDown={startSplitDrag}
                    style={{
                      width: 6,
                      cursor: 'col-resize',
                      background: isDraggingSplit.current ? '#534AB7' : '#e0e0e0',
                      borderRadius: 3,
                      margin: '0 4px',
                      flexShrink: 0,
                      transition: 'background 0.15s',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <div style={{ width: 2, height: 20, background: '#aaa', borderRadius: 1 }} />
                  </div>

                  {/* 右区：预览 */}
                  <div style={{ flex: `1 1 0`, minWidth: 0, overflow: 'hidden' }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 8, color: '#555' }}>实时预览</label>
                    <div style={{
                      border: '0.5px solid #ddd',
                      borderRadius: 8,
                      padding: 16,
                      minHeight: 320,
                      maxHeight: 'calc(100vh - 280px)',
                      background: '#fafafa',
                      overflow: 'auto'
                    }}>
                      <MathJaxPreview
                        latex={(editTab === 'content') ? (() => {
                          // 预览时用 editOptions 生成干净选项，避免 textarea 中的错误 LaTeX 影响渲染
                          if (editType === '单选' || editType === '多选') {
                            const validOpts = editOptions.filter(o => o.trim())
                            if (validOpts.length > 0) {
                              let preview = editContent
                                .replace(/\\item\s*[^\n]*/g, '')
                                // 同时清理 A. / B. / C. / D. 格式的选项行，避免重复标签
                                .replace(/^\s*[A-D]\.\s*[^\n]*$/gm, '')
                                .replace(/\\begin\{array\}[\s\S]*?\\end\{array\}\s*/g, '')
                                .replace(/\n{3,}/g, '\n\n').trim()
                              // 把 content 中残留的 \\img{} 提取出来，放到选项后面（不要在题目和选项之间）
                              const trailingImgs: string[] = []
                              const imgMatches = [...preview.matchAll(/\\img[\{\[]\s*[^\}\]\s]+\s*[\}\]]?/g)]
                              imgMatches.forEach(m => trailingImgs.push(m[0]))
                              if (trailingImgs.length > 0) {
                                preview = preview.replace(/\\img[\{\[][^\s]*/g, '').replace(/\n{3,}/g, '\n\n').trim()
                              }
                              const optionsPart = validOpts.map(o => `\\item ${o}`).join('\n')
                              const imgPart = trailingImgs.length > 0 ? '\n' + trailingImgs.join('\n') : ''
                              return preview + '\n' + optionsPart + imgPart
                            }
                          }
                          return editContent
                        })() : editAnalysis}
                        imageUrls={editImages}
                        questionType={editType}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* 选择题选项编辑区 - 紧凑行内显示 */}
              {(editType === '单选' || editType === '多选') && (
                <div style={{ marginBottom: 16, padding: '10px 14px', background: '#f8f9fa', borderRadius: 8, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#534AB7', marginRight: 4 }}>选项</span>
                  {editOptions.map((opt, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#333', minWidth: 20 }}>{['A', 'B', 'C', 'D', 'E'][i]}.</span>
                      <input
                        value={opt}
                        onChange={e => {
                          const next = [...editOptions]
                          next[i] = e.target.value
                          setEditOptions(next)
                          // 同步更新 editContent 底部的 \item 选项块，确保 save 时能提取到最新选项
                          let syncedContent = editContent
                          // 先提取 content 末尾可能跟着的 \img{} 行（这些应该在选项之后）
                          const trailingImgRe = /\n\\img[\{\[][^\s]*[\}\]]?\s*$/
                          let trailingImg = ''
                          const imgMatch = syncedContent.match(trailingImgRe)
                          if (imgMatch) {
                            trailingImg = imgMatch[0].trim()
                            syncedContent = syncedContent.slice(0, imgMatch.index)
                          }
                          // 删除 content 末尾已有的 \item 块（用第一个 \item 位置划分）
                          const itemRe = /\\item\s*/g
                          const allMatches = [...syncedContent.matchAll(itemRe)]
                          if (allMatches.length > 0) {
                            const firstItemIdx = allMatches[0].index!
                            const beforeItems = syncedContent.slice(0, firstItemIdx)
                            const stemHasItems = /\\item\s*/.test(beforeItems)
                            if (!stemHasItems) {
                              syncedContent = beforeItems.trim()
                            }
                          }
                          // 追加新的 \item 块（清理选项中可能残留的图片标签）
                          const validOpts = next.map(o => o.replace(/\\img[\{\[][^\s]*/g, '').trim()).filter(o => o)
                          if (validOpts.length > 0) {
                            syncedContent = syncedContent + '\n' + validOpts.map((o: string) => `\\item ${o}`).join('\n')
                          }
                          // 把末尾的 \img{} 放回到最后
                          if (trailingImg) {
                            syncedContent = syncedContent + '\n' + trailingImg
                          }
                          setEditContent(syncedContent)
                        }}
                        placeholder={`选项${['A', 'B', 'C', 'D', 'E'][i]}`}
                        style={{ width: 180, padding: '6px 10px', borderRadius: 6, border: '0.5px solid #ddd', fontSize: 13, boxSizing: 'border-box' }}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  onClick={handleSaveQuestion}
                  style={{
                    padding: '10px 28px',
                    borderRadius: 8,
                    border: 'none',
                    background: '#534AB7',
                    color: '#fff',
                    fontSize: 15,
                    fontWeight: 500,
                    cursor: 'pointer'
                  }}
                >
                  {editingQuestion ? '更新试题' : '保存试题'}
                </button>
                {editingQuestion && (
                  <button
                    onClick={() => {
                      setEditingQuestion(null)
                      setEditTitle('')
                      setEditContent('')
                      
                      setEditAnalysis('')
                      setEditOptions(['', '', '', ''])
                      setEditAnswer('')
                      setEditCategory('')
                      setEditTags('')
                      setEditSource('')
                      setEditImages(new Map())
                      setEditTab('content')
                    }}
                    style={{
                      padding: '10px 28px',
                      borderRadius: 8,
                      border: '0.5px solid #ddd',
                      background: '#fff',
                      color: '#666',
                      fontSize: 15,
                      cursor: 'pointer'
                    }}
                  >
                    取消编辑
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ========== 批量录题页面 ========== */}
        {activeTab === 'import' && (
          <div style={{ maxWidth: 1000, margin: '0 auto' }}>
            {/* 步骤指示器 */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 0, marginBottom: 24 }}>
              {[
                { step: 1, label: '上传 ZIP' },
                { step: 2, label: '选择题目' },
                { step: 3, label: '配置保存' },
              ].map((s, i) => (
                <div key={s.step} style={{ display: 'flex', alignItems: 'center' }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%',
                    background: batchStep >= s.step ? '#534AB7' : '#e0e0e0',
                    color: batchStep >= s.step ? '#fff' : '#999',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, fontWeight: 600
                  }}>
                    {batchStep > s.step ? '✓' : s.step}
                  </div>
                  <span style={{
                    marginLeft: 8, fontSize: 13,
                    color: batchStep >= s.step ? '#333' : '#999',
                    fontWeight: batchStep === s.step ? 600 : 400
                  }}>{s.label}</span>
                  {i < 2 && (
                    <div style={{
                      width: 60, height: 2,
                      background: batchStep > s.step ? '#534AB7' : '#e0e0e0',
                      margin: '0 16px'
                    }} />
                  )}
                </div>
              ))}
            </div>

            {/* Step 1: 上传 ZIP */}
            {batchStep === 1 && (
              <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 32 }}>
                <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>上传 Overleaf ZIP 压缩包</h2>
                <p style={{ fontSize: 13, color: '#666', marginBottom: 24 }}>
                  支持 Overleaf 导出的 ZIP 文件，自动解析其中的 .tex 文件和图片
                </p>
                
                {/* 上传区域 */}
                <label style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  border: '2px dashed #d0d0d0', borderRadius: 12, padding: '48px 24px',
                  cursor: batchUploading ? 'not-allowed' : 'pointer',
                  background: batchUploading ? '#f9f9f9' : '#fafafa',
                  transition: 'border-color 0.2s',
                }}
                  onDragOver={e => { e.preventDefault(); (e.currentTarget as HTMLElement).style.borderColor = '#534AB7' }}
                  onDragLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#d0d0d0' }}
                  onDrop={e => {
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).style.borderColor = '#d0d0d0';
                    const file = e.dataTransfer.files[0];
                    if (file) handleBatchUpload(file);
                  }}
                >
                  <input
                    type="file"
                    accept=".zip"
                    disabled={batchUploading}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleBatchUpload(f); e.target.value = '' }}
                    style={{ display: 'none' }}
                    id="batch-zip-upload"
                  />
                  {batchUploading ? (
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 36, marginBottom: 12 }}>⏳</div>
                      <div style={{ fontSize: 15, color: '#333' }}>正在上传并解析 ZIP...</div>
                      <div style={{ fontSize: 13, color: '#999', marginTop: 8 }}>大文件可能需要几秒钟</div>
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 48, marginBottom: 12 }}>📦</div>
                      <div style={{ fontSize: 15, color: '#333', marginBottom: 4 }}>拖拽 ZIP 文件到此处</div>
                      <div style={{ fontSize: 13, color: '#999' }}>或点击选择文件</div>
                    </div>
                  )}
                </label>
              </div>
            )}

            {/* Step 2: 选择 .tex 文件 → 解析题目 */}
            {batchStep === 2 && (
              <div>
                {/* .tex 文件列表 */}
                <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 20, marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>ZIP 中的 .tex 文件</h3>
                    <button onClick={() => { setBatchStep(1); setBatchTexFiles([]); setBatchSessionId(''); setBatchQuestions([]); setBatchSelectedIds(new Set()); }}
                      style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, border: '0.5px solid #ddd', background: '#fff', color: '#666', cursor: 'pointer' }}>
                      返回重选
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {batchTexFiles.map((f: any) => (
                      <div key={f.relativePath}
                        onClick={() => batchSelectedFile === f.relativePath ? null : handleBatchParse(f.relativePath)}
                        style={{
                          padding: '10px 14px', borderRadius: 8,
                          border: batchSelectedFile === f.relativePath ? '2px solid #534AB7' : '0.5px solid #e8e8e4',
                          background: batchSelectedFile === f.relativePath ? '#EEEDFE' : '#fafafa',
                          cursor: batchSelectedFile === f.relativePath ? 'default' : 'pointer',
                          display: 'flex', alignItems: 'center', gap: 10,
                          opacity: batchParsing ? 0.5 : 1
                        }}
                      >
                        <span style={{ fontSize: 18 }}>📄</span>
                        <span style={{ fontSize: 13, color: '#333' }}>{f.name}</span>
                        {batchSelectedFile === f.relativePath && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#534AB7', fontWeight: 600 }}>已选中</span>}
                      </div>
                    ))}
                  </div>
                </div>

                {/* 解析结果 */}
                {batchParsing && (
                  <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 32, textAlign: 'center' }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>🔍</div>
                    <div style={{ fontSize: 15, color: '#333' }}>正在解析题目...</div>
                  </div>
                )}

                {!batchParsing && batchQuestions.length > 0 && (
                  <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 20 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                        解析结果：共 {batchQuestions.filter((q: any) => !q.isDuplicate).length} 道题
                        {batchSelectedIds.size > 0 && <span style={{ fontSize: 13, color: '#534AB7', marginLeft: 8 }}>（已选 {batchSelectedIds.size} 道）</span>}
                      </h3>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {/* 重新解析按钮：删除题目后可刷新去重状态 */}
                        <button
                          onClick={() => {
                            if (!batchSelectedFile) return
                            setExpandedBatchQId(null)
                            setEditedBatchContents({})
                            handleBatchParse(batchSelectedFile)
                          }}
                          disabled={batchParsing || !batchSelectedFile}
                          title="删除题目后点击此按钮刷新去重状态"
                          style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, border: '0.5px solid #ddd', background: '#fff', color: '#666', cursor: 'pointer' }}>
                          🔄 重新解析
                        </button>
                        <button onClick={() => {
                          const available = batchQuestions.filter((q: any) => !q.isDuplicate)
                          if (batchSelectedIds.size === available.length) {
                            setBatchSelectedIds(new Set())
                          } else {
                            setBatchSelectedIds(new Set(available.map((q: any) => q._tempId)))
                          }
                        }} style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, border: '0.5px solid #ddd', background: '#fff', color: '#666', cursor: 'pointer' }}>
                          {batchSelectedIds.size === batchQuestions.filter((q: any) => !q.isDuplicate).length ? '取消全选' : '全选'}
                        </button>
                        <button
                          onClick={() => setBatchStep(3)}
                          disabled={batchSelectedIds.size === 0}
                          style={{
                            fontSize: 13, padding: '6px 16px', borderRadius: 6, border: 'none',
                            background: batchSelectedIds.size > 0 ? '#534AB7' : '#e0e0e0',
                            color: '#fff', cursor: batchSelectedIds.size > 0 ? 'pointer' : 'not-allowed'
                          }}
                        >
                          下一步：配置保存 ({batchSelectedIds.size})
                        </button>
                      </div>
                    </div>

                    {/* 题目列表 */}
                    {batchQuestions.filter((q: any) => !q.isDuplicate).map((q: any, idx: number) => {
                      const isSelected = batchSelectedIds.has(q._tempId)
                      const isExpanded = expandedBatchQId === q._tempId
                      const greyed = q.isDuplicate
                      let displayContent = editedBatchContents[q._tempId] ?? q.content
                      // 单选/多选：选项已从 content 中提取出去，预览时补回（用 \\item 格式，方便 preprocessLatex 渲染）
                      const isChoice = q.type === '单选' || q.type === '多选'
                      const hasOwnArrayOpts = /\\end\{array\}/.test(displayContent)
                      if (isChoice && q.options && q.options.length > 0 && !/\\item\s*/.test(displayContent) && !hasOwnArrayOpts) {
                        displayContent = displayContent + '\n' + q.options.map((o: string) => `\\item ${o}`).join('\n')
                      }
                      return (
                        <div key={q._tempId} style={{
                          border: isSelected ? '2px solid #534AB7' : greyed ? '0.5px solid #eee' : '0.5px solid #e8e8e4',
                          borderRadius: 8, marginBottom: 8, background: greyed ? '#f5f5f5' : isSelected ? '#EEEDFE' : '#fff',
                          opacity: greyed ? 0.55 : 1, overflow: 'hidden',
                        }}>
                          {/* 折叠头部：checkbox + 信息 + 展开/收起按钮 */}
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 16px', cursor: greyed ? 'not-allowed' : 'pointer' }}>
                            {/* 选择框（独立点击区域，阻止冒泡到展开） */}
                            <div
                              onClick={e => {
                                e.stopPropagation()
                                if (greyed) return
                                const next = new Set(batchSelectedIds)
                                isSelected ? next.delete(q._tempId) : next.add(q._tempId)
                                setBatchSelectedIds(next)
                              }}
                              style={{
                                width: 20, height: 20, borderRadius: 4, flexShrink: 0, marginTop: 2,
                                border: `2px solid ${isSelected ? '#534AB7' : greyed ? '#ddd' : '#ccc'}`,
                                background: isSelected ? '#534AB7' : 'transparent',
                                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 12, fontWeight: 700, cursor: greyed ? 'not-allowed' : 'pointer'
                              }}>
                              {isSelected ? '✓' : ''}
                            </div>
                            {/* 题目信息，点击展开/收起 */}
                            <div style={{ flex: 1, minWidth: 0 }} onClick={() => {
                              if (greyed) return
                              setExpandedBatchQId(isExpanded ? null : q._tempId)
                            }}>
                              <div style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: '#534AB7' }}>#{idx + 1}</span>
                                <span style={{
                                  fontSize: 11, padding: '1px 6px', borderRadius: 3,
                                  background: q.type === '单选' ? '#e3f2fd' : q.type === '多选' ? '#fce4ec' : q.type === '填空' ? '#fff3e0' : '#e8f5e9',
                                  color: q.type === '单选' ? '#1976d2' : q.type === '多选' ? '#c62828' : q.type === '填空' ? '#f57c00' : '#2e7d32'
                                }}>{q.type}</span>
                                {q.options && q.options.length > 0 && <span style={{ fontSize: 11, color: '#999' }}>{q.options.length} 个选项</span>}
                                {q.answer && <span style={{ fontSize: 11, color: '#666' }}>答案: {q.answer}</span>}
                                {greyed && <span style={{ fontSize: 11, color: '#e65100', background: '#fff3e0', padding: '1px 6px', borderRadius: 3 }}>已录入</span>}
                                {isExpanded && <span style={{ fontSize: 11, color: '#534AB7', marginLeft: 'auto' }}>收起 ▲</span>}
                                {!isExpanded && <span style={{ fontSize: 11, color: '#999', marginLeft: 'auto' }}>展开预览 ▼</span>}
                              </div>
                              {/* 折叠时显示简短文本摘要 */}
                              {!isExpanded && (
                                <div style={{ fontSize: 13, color: greyed ? '#999' : '#333', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {(q.preview || q.title || displayContent).replace(/\\[a-zA-Z]+/g, '').slice(0, 100)}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* 展开的预览 + 编辑区域 */}
                          {isExpanded && !greyed && (
                            <div style={{ padding: '0 16px 16px 48px', borderTop: '0.5px solid #e8e8e4' }}>
                              {/* 渲染预览 */}
                              <div style={{ marginTop: 12 }}>
                                <div style={{ fontSize: 11, color: '#999', marginBottom: 6 }}>── 渲染预览 ──</div>
                                <div style={{
                                  background: '#fafaf8', borderRadius: 6, padding: '12px 16px',
                                  border: '0.5px solid #e8e8e4', minHeight: 40
                                }}>
                                  <MathJaxPreview
                                    latex={displayContent}
                                    imageUrls={new Map(Object.entries(q.images || {}))}
                                    questionType={q.type}
                                    style={{ fontSize: 14, lineHeight: 1.8 }}
                                  />
                                </div>
                              </div>

                              {/* 可编辑源代码 */}
                              <div style={{ marginTop: 12 }}>
                                <div style={{ fontSize: 11, color: '#999', marginBottom: 6 }}>── 源代码（可直接编辑修改）──</div>
                                <textarea
                                  value={displayContent}
                                  onChange={e => {
                                    setEditedBatchContents(prev => ({ ...prev, [q._tempId]: e.target.value }))
                                  }}
                                  style={{
                                    width: '100%', minHeight: 100, padding: '10px 12px',
                                    borderRadius: 6, border: '0.5px solid #d0d0cc',
                                    fontSize: 13, fontFamily: '"Fira Code", "Cascadia Code", "Consolas", monospace',
                                    lineHeight: 1.6, background: '#fdfdfc', resize: 'vertical',
                                    color: '#333', outline: 'none',
                                  }}
                                  onFocus={e => { e.target.style.borderColor = '#534AB7' }}
                                  onBlur={e => { e.target.style.borderColor = '#d0d0cc' }}
                                />
                              </div>

                              {/* 解析内容展示 */}
                              {q.analysis && (
                                <div style={{ marginTop: 12 }}>
                                  <div style={{ fontSize: 11, color: '#999', marginBottom: 6 }}>── 解析 ──</div>
                                  <div style={{
                                    background: '#f5fdf5', borderRadius: 6, padding: '10px 14px',
                                    border: '0.5px solid #d8ead8', fontSize: 13, lineHeight: 1.7, color: '#555'
                                  }}>
                                    <MathJaxPreview
                                      latex={q.analysis}
                                      imageUrls={new Map(Object.entries(q.images || {}))}
                                      questionType={q.type}
                                      style={{ fontSize: 13, lineHeight: 1.7 }}
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {!batchParsing && batchQuestions.length === 0 && batchSelectedFile && (
                  <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 32, textAlign: 'center' }}>
                    <div style={{ fontSize: 13, color: '#999' }}>该文件中未找到题目</div>
                  </div>
                )}
              </div>
            )}

            {/* Step 3: 配置保存 */}
            {batchStep === 3 && (
              <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                  <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>配置并保存</h2>
                  <button onClick={() => setBatchStep(2)}
                    style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, border: '0.5px solid #ddd', background: '#fff', color: '#666', cursor: 'pointer' }}>
                    返回选择
                  </button>
                </div>

                <div style={{ marginBottom: 20, padding: '12px 16px', background: '#EEEDFE', borderRadius: 8 }}>
                  <span style={{ fontSize: 13, color: '#534AB7' }}>
                    即将保存 <strong>{batchSelectedIds.size}</strong> 道题目到题库
                  </span>
                </div>

                {/* 配置项 */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 24 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: '#555' }}>
                      知识点分类 <span style={{ color: '#e74c3c' }}>*</span>
                    </label>
                    <select value={batchCategory} onChange={e => setBatchCategory(e.target.value)}
                      style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #ddd', fontSize: 14, boxSizing: 'border-box' }}>
                      <option value="">请选择分类</option>
                      {categories.map(cat => (
                        <optgroup key={cat.id} label={cat.name}>
                          <option value={cat.id}>{cat.name}</option>
                          {cat.children?.map(child => (
                            <option key={child.id} value={child.id}>　{child.name}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: '#555' }}>难度</label>
                    <select value={batchDifficulty} onChange={e => setBatchDifficulty(e.target.value)}
                      style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #ddd', fontSize: 14 }}>
                      {['较易', '易', '中', '较难', '难'].map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: '#555' }}>年级</label>
                    <select value={batchGrade} onChange={e => setBatchGrade(e.target.value)}
                      style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #ddd', fontSize: 14 }}>
                      {['高一', '高二', '高三'].map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </div>
                </div>

                {/* 保存按钮 */}
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                  <button
                    onClick={handleBatchSave}
                    disabled={!batchCategory || batchSaving}
                    style={{
                      padding: '12px 40px', borderRadius: 8, border: 'none',
                      background: batchCategory && !batchSaving ? '#534AB7' : '#e0e0e0',
                      color: '#fff', fontSize: 15, fontWeight: 600,
                      cursor: batchCategory && !batchSaving ? 'pointer' : 'not-allowed'
                    }}
                  >
                    {batchSaving ? '保存中...' : `批量保存 ${batchSelectedIds.size} 道题`}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========== 试卷篮页面 ========== */}
        {activeTab === 'basket' && (
          <div style={{ maxWidth: 1000, margin: '0 auto' }}>
            <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 16 }}>
                <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>旧版组卷</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-end' }}>
                  {/* 第一行：预览按钮 */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => handlePreviewPDF(false, false)}
                      style={{
                        padding: '8px 16px',
                        borderRadius: 8,
                        border: '0.5px solid #1976d2',
                        background: '#e3f2fd',
                        color: '#1976d2',
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: 'pointer'
                      }}
                    >
                      🔍 预览 PDF（学生版）
                    </button>
                  </div>
                  {/* 第二行：导出选项 */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                    <button onClick={handleClearBasket} style={{ padding: '8px 16px', borderRadius: 8, border: '0.5px solid #fcc', background: '#fee', color: '#c33', fontSize: 13, cursor: 'pointer' }}>
                      清空旧版组卷
                    </button>
                    <span style={{ color: '#ccc', fontSize: 13 }}>|</span>
                    <button onClick={() => handleGeneratePaper(false, false, 'pdf')} style={{ padding: '8px 16px', borderRadius: 8, border: '0.5px solid #534AB7', background: '#fff', color: '#534AB7', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                      📄 学生版 PDF
                    </button>
                    <button onClick={() => handleGeneratePaper(true, true, 'pdf')} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#2e7d32', color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                      📄 教师版+解析 PDF
                    </button>
                    <span style={{ color: '#ccc', fontSize: 13 }}>|</span>
                    <button onClick={() => handleGeneratePaper(false, false, 'zip')} style={{ padding: '8px 16px', borderRadius: 8, border: '0.5px solid #f57c00', background: '#fff3e0', color: '#f57c00', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                      📦 学生版 LaTeX
                    </button>
                    <button onClick={() => handleGeneratePaper(true, true, 'zip')} style={{ padding: '8px 16px', borderRadius: 8, border: '0.5px solid #2e7d32', background: '#e8f5e9', color: '#2e7d32', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                      📦 教师版+解析 LaTeX
                    </button>
                    <span style={{ color: '#ccc', fontSize: 13 }}>|</span>
                    <button onClick={() => handleGeneratePaper(true, true, 'pdf', 'a4')} style={{ padding: '8px 16px', borderRadius: 8, border: '0.5px solid #534AB7', background: '#EEEDFE', color: '#534AB7', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                      📄 A4教师版PDF
                    </button>
                    <button onClick={() => handleGeneratePaper(true, true, 'zip', 'a4')} style={{ padding: '8px 16px', borderRadius: 8, border: '0.5px solid #534AB7', background: '#EEEDFE', color: '#534AB7', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                      📦 A4教师版LaTeX
                    </button>
                  </div>
                  <div style={{ fontSize: 12, color: '#999' }}>预览 ≈ 5-10秒 · PDF导出 ≈ 5-10秒 · LaTeX导出 ≈ 即时</div>
                </div>
              </div>

              {basketQuestions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>🧺</div>
                  <div>旧版组卷为空，去试题库添加题目吧</div>
                </div>
              ) : (
                basketQuestions.map((q, index) => (
                  <div key={q.id} style={{ border: '0.5px solid #e8e8e4', borderRadius: 8, padding: 16, marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: '#534AB7', fontWeight: 600 }}>#{index + 1}</span>
                      <button
                        onClick={() => removeFromBasket(q.id)}
                        style={{
                          fontSize: 12,
                          padding: '4px 12px',
                          borderRadius: 4,
                          border: '0.5px solid #fcc',
                          background: '#fee',
                          color: '#c33',
                          cursor: 'pointer'
                        }}
                      >
                        移除
                      </button>
                    </div>
                    <MathJaxPreview latex={q.content} imageUrls={new Map(Object.entries(q.images || {}))} questionType={q.type} style={{ fontSize: 14 }} />
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ========== 新版组卷页面 ========== */}
        {activeTab === 'composer' && (
          <React.Suspense fallback={<div style={{padding:40,textAlign:'center',color:'#666'}}>加载新版组卷中...</div>}>
            <ErrorBoundary fallback={<div style={{padding:40,color:'#c00'}}>新版组卷加载失败，请刷新页面重试。如持续失败可先用旧版组卷。</div>}>
              <ExamComposer
                questions={questions}
                basketIds={basket}
                onBasketChange={setBasket}
                onClearBasket={handleClearBasket}
                apiBase={API}
              />
            </ErrorBoundary>
          </React.Suspense>
        )}

        {/* ========== 已下载的试卷页面 ========== */}
        {activeTab === 'papers' && (
          <DownloadedPapers />
        )}

        {/* ========== PDF 批量录题页面 ========== */}
        {activeTab === 'pdf-batch' && (
          <PdfBatchEntry categories={categories} />
        )}

        {/* ========== 关于页面 ========== */}
        {activeTab === 'about' && (
          <div style={{ maxWidth: 600, margin: '0 auto' }}>
            <div style={{ background: '#fff', borderRadius: 12, border: '0.5px solid #e8e8e4', padding: 32, textAlign: 'center' }}>
              <div style={{ fontSize: 64, marginBottom: 16 }}>∑</div>
              <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>田随林用AI打造的数学试题库</h2>
              <p style={{ color: '#666', lineHeight: 1.8, marginBottom: 24 }}>
                专为热爱数学的老师和同学免费服务！<br/>
                支持快速组卷，一键导出！祝大家天天进步！
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 32 }}>
                <div style={{ padding: 16, background: '#f9f9f9', borderRadius: 8 }}>
                  <div style={{ fontSize: 24, fontWeight: 600, color: '#534AB7' }}>{questions.length}</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>试题总数</div>
                </div>
                <div style={{ padding: 16, background: '#f9f9f9', borderRadius: 8 }}>
                  <div style={{ fontSize: 24, fontWeight: 600, color: '#534AB7' }}>{categories.length}</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>知识分类</div>
                </div>
                <div style={{ padding: 16, background: '#f9f9f9', borderRadius: 8 }}>
                  <div style={{ fontSize: 24, fontWeight: 600, color: '#534AB7' }}>{basket.length}</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>旧版组卷</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* PDF 预览弹窗 */}
      {previewLoading && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
        }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 32, textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
            <div style={{ fontSize: 15, color: '#333' }}>正在编译 PDF，请稍候...</div>
            <div style={{ fontSize: 13, color: '#999', marginTop: 8 }}>首次编译约需 10-15 秒</div>
          </div>
        </div>
      )}

      {previewUrl && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', flexDirection: 'column'
        }}>
          {/* 弹窗标题栏 */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 20px', background: '#fff', borderBottom: '1px solid #eee'
          }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>试卷 PDF 预览</span>
            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={() => { setPreviewUrl(null) }}
                style={{ padding: '6px 16px', borderRadius: 6, border: '0.5px solid #ccc', background: '#fff', color: '#666', fontSize: 13, cursor: 'pointer' }}>
                关闭预览
              </button>
            </div>
          </div>
          {/* iframe 嵌入 PDF */}
          <iframe
            src={previewUrl}
            style={{ flex: 1, border: 'none', width: '100%', background: '#333' }}
            title="试卷预览"
          />
        </div>
      )}
    </div>
  )
}
