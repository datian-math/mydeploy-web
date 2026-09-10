// LaTeX / MathJax 渲染组件与相关文本预处理工具
// 从 App.tsx 抽出，供题库页与白板页共用
import React, { useEffect, useRef, useState } from 'react'
import { API, IS_GITHUB_PAGES } from '../lib/config'

// MathJax 全局类型声明
declare global {
  interface Window {
    MathJax: any
  }
}

// 预处理 LaTeX 代码，转换不支持的宏
// questionType: 题型，用于决定 \item 的转换格式
export function preprocessLatex(latex: string, questionType?: string): string {
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
    // 归一化写坏的公式定界符：录题时全角/半角没分清，混进来 \（  \） 这种写法
    // （反斜杠后跟全角括号在 LaTeX 里没有任何正当含义）。
    // 全库实测 116 处，其中 115 处前面都存在一个「尚未闭合的 \(」——
    // 说明它本该是收尾定界符，所以统一还原成 \)，而不是 \(。
    // 典型形态：`则 \(A\cap B=\（　　）`（答题空括号），还原后公式能正常渲染。
    .replace(/\\（/g, '\\)')
    .replace(/\\）/g, '\\)')
    // 收尾定界符被截断：内容以孤立反斜杠结尾（`\((\quad)\` 少了那个 `)`），全库 6 道。
    // 用后顾断言排除「结尾是换行符 \\」的正常写法，只补真正孤立的那一个反斜杠。
    .replace(/(?<!\\)\\$/, '\\)')
    // 未解析的图片引用宏，渲染成可读的提示而不是红色报错
    .replace(/\\figref\s*\{[^}]*\}/g, '（见图）')
    .replace(/\\reffig\s*\{[^}]*\}/g, '（见图）')
    // 移除/替换 MathJax 不识别的图形/容器环境（保险：万一导入时漏掉）
    // tikzpicture：整块替换为占位符（正常情况已被编译为SVG图片，不会走到这里）
    // 注意：\s* 容忍 \begin {tikzpicture} 这种带空格的写法
    .replace(/\\begin\s*\{tikzpicture\}[\s\S]*?\\end\s*\{tikzpicture\}/g, '〔图示〕')
    .replace(/\\begin\s*\{tikzpicture\}[\s\S]*$/g, '〔图示〕') // 未闭合的
    // 清理残留的 TikZ 命令（\begin{tikzpicture} 被 minipage 清理误删的情况）
    .replace(/\\(draw|node|path|fill|coordinate|pgftransform\w*|pgfmathsetmacro|usetikzlibrary)\b[^\n]*\n?/g, '')
    .replace(/\\end\s*\{tikzpicture\}/g, '〔图示〕')
    .replace(/\\begin\s*\{tikzpicture\}(\[[^\]]*\])?/g, '')
    .replace(/\\begin\{picture\}[\s\S]*?\\end\{picture\}/g, '〔图示〕')
    .replace(/\\begin\{pspicture\}[\s\S]*?\\end\{pspicture\}/g, '〔图示〕')
    .replace(/\\begin\{figure\}[\s\S]*?\\end\{figure\}/g, '〔图〕')
    // minipage: 提取内部，丢弃容器（含 [pos]{width} 参数）
    .replace(/\\begin\{minipage\}(\[[^\]]*\])?\{[^}]*\}/g, '').replace(/\\end\{minipage\}/g, '')
    .replace(/\\begin\{center\}[\s\S]*?\\end\{center\}/g, (m) => m.replace(/\\begin\{center\}/g, '').replace(/\\end\{center\}/g, ''))
    .replace(/\\begin\{tabular\}[\s\S]*?\\end\{tabular\}/g, (m) => m.replace(/\\begin\{tabular\}(\[[^\]]*\])?\{[^}]*\}/g, '').replace(/\\end\{tabular\}/g, '').replace(/\\hline/g, '').replace(/\\\\/g, ' | ').replace(/&/g, ' | '))
    .replace(/\\begin\{enumerate\}[\s\S]*?\\end\{enumerate\}/g, (m) => m.replace(/\\begin\{enumerate\}(\[[^\]]*\])?/g, '').replace(/\\end\{enumerate\}/g, '').replace(/\\item\s*/g, '\n• '))
    .replace(/\\begin\{itemize\}[\s\S]*?\\end\{itemize\}/g, (m) => m.replace(/\\begin\{itemize\}(\[[^\]]*\])?/g, '').replace(/\\end\{itemize\}/g, '').replace(/\\item\s*/g, '\n• '))
    .replace(/\\begin\{tasks\}\(\d+\)[\s\S]*?\\end\{tasks\}/g, (m) => m.replace(/\\begin\{tasks\}\(\d+\)/g, '').replace(/\\end\{tasks\}/g, '').replace(/\\task(?:\[[^\]]*\])?\s*/g, '\n① '))
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
export function extractAbcdOptions(content: string): { cleanedContent: string; abcdOptions: string[] } {
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

/**
 * 清理 HTML <img> 标签周围的多余空白。
 * 把 <img> 前后的连续换行/空格/制表符折叠为单个 \n，
 * 避免题目内容和图片之间出现大段空白行。
 */
export function compactImageWhitespace(text: string): string {
  if (!text) return text
  // 把 <img 之前的连续空白（\n、空格、\t）折叠为单个 \n
  text = text.replace(/[\s\n]*(<img\b[^>]*>)/g, '\n$1')
  // 把 <img> 之后的连续空白折叠为单个 \n
  text = text.replace(/(<img\b[^>]*>)[\s\n]*/g, '$1\n')
  // 把整段里 3 个及以上连续换行折叠为 2 个
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

// 将 LaTeX 表格语法转换为 HTML 表格（MathJax 不支持 tabular 环境）
export function convertLatexTables(text: string): string {
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

// 为未包裹的原始 LaTeX 数学内容添加 \( ... \) 定界符
// 用于修复 analysis/answerContent 等字段中缺少数学模式定界符的问题
//
// ⚠️ 这个函数以前是完全失效的：里面所有正则都写成 /\\\\frac/ 这种形式，
// 而正则字面量里 \\\\ 表示「两个反斜杠」，题库内容里却只有一个 ——
// 所以它从来没匹配过任何东西（99 道题的解析因此整段显示成 LaTeX 源码）。
// 修好之后它第一次真正生效，因此必须做得非常保守：
// 只包裹「孤零零一行、没有任何定界符、也不含任何 LaTeX 结构」的行内数学，
// 其余一律原样放过。宁可少包一处，也不能把本来就渲染正常的解析弄坏。
export function ensureMathDelimiters(text: string): string {
  const lines = text.split('\n')

  // 先扫一遍全文，算出每一行「开头时」是否已经处于数学模式里。
  // 逐行看是看不出来的：多行块中间的行自己没有任何定界符，
  // 但它的上一行可能开着 \( 或 \[，把它当成裸 LaTeX 包一层就会和块围栏交叉
  // （实测有 19 处解析因此从干净变成有残留）。
  const startsInsideMath: boolean[] = []
  let depth = 0     // 数学模式 \( \) \[ \] $$
  let envDepth = 0  // \begin{...} ... \end{...}
  for (const line of lines) {
    startsInsideMath.push(depth > 0 || envDepth > 0)
    for (let k = 0; k < line.length; k++) {
      const ch = line[k]
      if (ch === '\\') {
        const nx = line[k + 1]
        if (nx === '(' || nx === '[') { depth++; k++; continue }
        if (nx === ')' || nx === ']') { if (depth > 0) depth--; k++; continue }
        // \begin{...} / \end{...} —— 环境体内部的行同样不能当裸 LaTeX 包裹
        // （例如 \begin{cases} 之后的中间几行，自己不带任何环境标记）
        if (line.startsWith('begin{', k + 1)) { envDepth++; k += 5; continue }
        if (line.startsWith('end{', k + 1)) { if (envDepth > 0) envDepth--; k += 3; continue }
        k++ // \命令 / \\ 换行 都不改变数学模式
        continue
      }
      if (ch === '$') {
        if (line[k + 1] === '$') { depth = depth > 0 ? depth - 1 : depth + 1; k++; continue }
        depth = depth > 0 ? depth - 1 : depth + 1
      }
    }
  }
  // 末行再补一个「行尾状态」，用于判断最后一行是否封闭
  startsInsideMath.push(depth > 0)

  const result: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 空行、HTML 行、以及「本身或上一行处于数学模式内」的行，一律原样保留
    if (!trimmed || /<[a-z][^>]*>/i.test(trimmed) || startsInsideMath[i] || startsInsideMath[i + 1]) {
      result.push(line)
      continue
    }

    // 已带任何一种定界符（$ \( \) \[ \]）的行一律原样保留
    if (/\$|\\\(|\\\)|\\\[|\\\]/.test(trimmed)) {
      result.push(line)
      continue
    }

    // 含 LaTeX 结构（对齐 & / 换行 \\ / 环境）的行不整体包裹
    if (/&|\\\\|\\begin\{|\\end\{/.test(trimmed)) {
      result.push(line)
      continue
    }

    // 检测是否包含原始 LaTeX 数学命令。
    // 末尾的 (?![a-zA-Z]) 防止把 \textwidth 误认成 \text、\int 误认成 \in。
    const hasMathCommand = /\\(because|therefore|frac|dfrac|tfrac|sqrt|sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|log|ln|exp|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|cdot|cdots|ldots|dots|left|right|mid|geq|ge|leq|le|neq|ne|pm|mp|times|div|ast|star|circ|angle|triangle|parallel|perp|odot|oplus|otimes|cup|cap|in|notin|subset|subseteq|supset|supseteq|setminus|emptyset|varnothing|forall|exists|overrightarrow|vec|mathbf|mathbb|mathcal|mathrm|text|operatorname|sum|prod|int|iint|oint|lim|infty|partial|nabla|overline|underline|overbrace|underbrace|bar|hat|tilde|dot|ddot|quad|qquad|binom|choose|sim|cong|equiv|approx|propto|to|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|Leftrightarrow|langle|rangle|ll|gg|prime|degree|hspace|vspace|displaystyle|limits|nolimits(?![a-zA-Z]))/.test(trimmed)

    if (!hasMathCommand) {
      result.push(line)
      continue
    }

    result.push(`\\(${trimmed}\\)`)
  }

  return result.join('\n')
}

// MathJax 预览组件 —— 比 KaTeX 更强大的 LaTeX 渲染
// MathJax 3 支持几乎所有标准 LaTeX 命令：\sqrt, \overrightarrow, \vec, \frac 等
export function MathJaxPreview({ latex, imageUrls, questionType, style, imgMaxWidth = 150, onRendered }: {
  latex: string
  imageUrls: Map<string, string>
  questionType?: string
  style?: React.CSSProperties
  /** 题图最大宽度（逻辑 px）。白板上投影用，需要比题库页更大 */
  imgMaxWidth?: number
  /** 渲染完成（含 MathJax typeset）后回调，白板用它触发导出/自适应 */
  onRendered?: () => void
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
      onRendered?.()
      return
    }

    try {
    // 预处理 LaTeX
    let processed = preprocessLatex(latex, questionType)
    // 修复高考题/题库图片路径
    if (IS_GITHUB_PAGES) {
      processed = processed.replace(/\/api\/exam-images\//g, '/mydeploy-web/exam-images/')
      processed = processed.replace(/\/api\/bank-images\//g, '/mydeploy-web/bank-images/')
    }
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
        return `<div style="display:block;min-height:60px;"><img src="${fullUrl}" alt="diagram" onerror="this.style.display='none';var s=this.nextElementSibling;if(s)s.style.display='block';" style="display:block;max-width:${imgMaxWidth}px;height:auto;margin:12px 0;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);" /><span style="display:none;color:#e74c3c;font-size:12px;padding:8px 0;">[图片: ${key} 未找到]</span></div>`
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

    // 清理 <img> 标签周围的多余空白（题干末尾的 \n 在预处理时被转成 <br/>，
    // 多个连续 <br/> 会堆出巨大空白行；折叠为单个或去掉）
    try {
      const root = containerRef.current
      // 找所有 img/img 容器
      const imgs = root.querySelectorAll('img')
      imgs.forEach((img) => {
        // 找 img 的前一个非空节点
        let prev = img.previousSibling
        while (prev && prev.nodeType === 3 && !prev.nodeValue) prev = prev.previousSibling
        // 折叠 img 之前的连续 <br/> 为一个
        let brCount = 0
        let p = prev
        while (p && p.nodeType === 1 && p.nodeName === 'BR') {
          brCount++
          const prevP = p.previousSibling
          if (brCount > 1) p.remove()
          p = prevP
        }
        // 折叠 img 之后的连续 <br/> 为一个
        let next = img.nextSibling
        brCount = 0
        while (next && next.nodeType === 1 && next.nodeName === 'BR') {
          brCount++
          const nextN = next.nextSibling
          if (brCount > 1) next.remove()
          next = nextN
        }
      })
      // 清理纯空白段落（只包含 <br/> 或空白文本的 <p>）
      root.querySelectorAll('p').forEach((p) => {
        const text = p.textContent || ''
        if (!text.trim() && !p.querySelector('img')) p.remove()
      })
    } catch {}

    // 调用 MathJax 渲染数学公式
    window.MathJax.typesetPromise([containerRef.current])
      .then(() => onRendered?.())
      .catch((err: any) => {
        console.error('MathJax typeset error:', err)
        onRendered?.()
      })
    } catch (err: any) {
      console.error('MathJaxPreview render error:', err)
      if (containerRef.current) {
        containerRef.current.innerHTML = `<p style="color:#c33">[渲染错误: ${err.message || 'unknown'}]</p>`
      }
      onRendered?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latex, imageUrls, questionType, ready])

  if (!ready) {
    return <div style={{ ...style, color: '#999', fontSize: 13 }}>正在加载 MathJax...</div>
  }

  return <div ref={containerRef} style={style} />
}

// 内联 MathJax 渲染组件（用于选项等短文本，可含行内数学公式）
export function MathJaxInline({ text }: { text: string }) {
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
