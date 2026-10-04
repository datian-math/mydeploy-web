// 题库智能搜索：把「自然语言多标签查询」翻译成「结构化筛选 + 打分排序」
//
// 核心哲学：不做硬 AND，做软排序 —— 让用户模糊地问，系统尽力地答。
// 满足的条件越多分越高、排越前，而不是差一个条件就 0 结果。
//
// 流程：归一化（LaTeX 无关化）→ 拆词 → 加权重打分 → ratio 排序 → 三层门槛过滤
//
// 字段适配说明：本项目的题库没有规格书里的 keywords / book / chapter / section，
// 用 tags（含来源文件名、年份、知识点）和 categoryName（11 个大类）代替。

// ==================== 一、归一化 ====================

/**
 * 把文本归一化成「LaTeX 无关」的形式，让不同写法能互相搜到。
 * \dfrac{1}{2} / \frac12 / \tfrac{1}{2} → 都含 frac
 * x^{2} 与 x^2 统一；\mathbb{R} 与 R 统一
 */
export function normalizeForSearch(s: any): string {
  if (!s) return ''
  let t = String(s)
  // 分数命令统一
  t = t.replace(/\\(dfrac|tfrac|frac)/g, 'frac')
  // 不等号统一
  t = t.replace(/\\geqslant|\\geq(?![a-z])|\\ge(?![a-z])/g, 'ge')
  t = t.replace(/\\leqslant|\\leq(?![a-z])|\\le(?![a-z])/g, 'le')
  t = t.replace(/\\neq|\\ne(?![a-z])/g, 'ne')
  // 排版命令丢弃
  t = t.replace(/\\(left|right|bigl|bigr|Bigl|Bigr|displaystyle|textstyle|limits|nolimits)/g, '')
  t = t.replace(/\\(cdot|times)/g, '*')
  t = t.replace(/\\div/g, '/')
  // 上下标花括号：x^{2} → x^2
  t = t.replace(/\^\{([^{}]*)\}/g, '^$1')
  t = t.replace(/_\{([^{}]*)\}/g, '_$1')
  // 字体/集合命令去外壳：\mathbb{R} → R
  t = t.replace(/\\(mathbb|mathrm|mathbf|mathcal|boldsymbol|text|operatorname)\s*\{([^{}]*)\}/g, '$2')
  // 剩余命令去反斜杠：\alpha → alpha
  t = t.replace(/\\([a-zA-Z]+)/g, '$1')
  // 其余 LaTeX 符号变空格
  t = t.replace(/[{}$\\]/g, ' ')
  return t.toLowerCase()
}

// ==================== 二、形近字容错 ====================

/**
 * 中文输入法常打错的形近字（双向映射）。
 * 只保留确实常见的组合 —— 早年版本里「解↔角」「曲↔区」这类不像的组合已删掉，
 * 它们会让「解三角形」被改写成「角三角形」从而误命中。
 */
const HOMOGLYPH: Record<string, string> = {
  炼: '练', 练: '炼',   // 精练 / 精炼
  椎: '锥', 锥: '椎',   // 棱锥 / 棱椎
  已: '己', 己: '已',
  末: '未', 未: '末',
  矩: '距', 距: '矩',   // 矩形 / 距形
  析: '折', 折: '析',   // 解析 / 解折
  圆: '园', 园: '圆',
  测: '侧', 侧: '测',   // 检测 / 检侧
  均: '匀', 匀: '均',   // 均值 / 匀值
}

/** 逐字替换试探，返回所有「改一个字」的变体 */
export function expandHomoglyph(s: string): string[] {
  const out: string[] = []
  const chars = Array.from(s)
  for (let i = 0; i < chars.length; i++) {
    const alt = HOMOGLYPH[chars[i]]
    if (alt && alt !== chars[i]) {
      out.push(chars.slice(0, i).join('') + alt + chars.slice(i + 1).join(''))
    }
  }
  return out
}

// ==================== 三、权重 ====================

/** 关键词命中不同字段的权重（取最高，多字段命中给小额加成） */
const TERM_WEIGHTS: Record<string, number> = {
  content: 10,     // 题干最重要
  category: 8,     // 分类（本项目用 categoryName 代替规格书的 section）
  tags: 6,         // 标签（含来源文件名、年份、知识点）
  options: 5,      // 选项
  source: 4,
  answer: 4,
  analysis: 2,     // 解析最长，权重必须低，否则长解析题霸榜
}

/** 结构化条件的权重 */
const WEIGHTS = { type: 15, image: 10, year: 12, source: 12 }

const MIN_RATIO = 0.42

// ==================== 四、查询解析 ====================

export interface ParsedQuery {
  raw: string
  terms: string[]
  orGroups: string[][]
  exclude: string[]
  type?: string
  hasImage?: boolean
  year?: string
  sources: string[]
  explicit: boolean
}

const TYPE_WORDS: Record<string, string> = {
  大题: '解答', 解答题: '解答', 解答: '解答',
  单选: '单选', 单选题: '单选', 选择题: '单选',
  多选: '多选', 多选题: '多选',
  填空: '填空', 填空题: '填空',
}
const IMG_YES = ['有图', '带图', '含图', '有图片', '图形']
const IMG_NO = ['无图', '不带图', '没有图', '不含图']
const SOURCE_WORDS = ['高考真题', '真题', '模拟', '模拟题', '讲义', '专题', '联考', '月考',
  '期中', '期末', '质检', '调研', '开学考', '诊断', '周考', '自主训练', '自编']

export function parseQuery(input: string): ParsedQuery {
  const raw = (input || '').trim()
  const pq: ParsedQuery = { raw, terms: [], orGroups: [], exclude: [], sources: [], explicit: false }
  if (!raw) return pq

  // 分隔符统一（- 保留为排除前缀）
  const norm = raw.replace(/[，,；;、+]/g, ' ').replace(/[-–—](?=\S)/g, ' -')
  const tokens = norm.split(/\s+/).filter(Boolean)

  for (let tok of tokens) {
    let neg = false
    if (tok.startsWith('-') && tok.length > 1) { neg = true; tok = tok.slice(1) }
    let m: RegExpMatchArray | null

    // ---- 显式语法 ----
    if ((m = tok.match(/^(类型|题型|type):(.+)$/i))) { pq.explicit = true; pq.type = TYPE_WORDS[m[2]] || m[2]; continue }
    if ((m = tok.match(/^(图|图片|image|img):(.+)$/i))) { pq.explicit = true; pq.hasImage = /有|yes|1|true|带|含/.test(m[2]); continue }
    if ((m = tok.match(/^(年|年份|year):(\d{2,4})$/i))) { pq.explicit = true; pq.year = m[2].length === 2 ? '20' + m[2] : m[2]; continue }
    if ((m = tok.match(/^(来源|src|source|tag|标签):(.+)$/i))) { pq.explicit = true; pq.sources.push(m[2]); continue }
    if ((m = tok.match(/^(正文|题干|text|content|答|答案|ans|选项|opt):(.+)$/i))) {
      if (neg) pq.exclude.push(m[2]); else pq.terms.push(m[2]); continue
    }

    // ---- 自然语言 ----
    if (TYPE_WORDS[tok]) { pq.type = TYPE_WORDS[tok]; continue }
    if (IMG_YES.includes(tok)) { pq.hasImage = true; continue }
    if (IMG_NO.includes(tok)) { pq.hasImage = false; continue }
    if (/^(19|20)\d{2}$/.test(tok)) { pq.year = tok; continue }
    if (/^(19|20)\d{2}年$/.test(tok)) { pq.year = tok.slice(0, 4); continue }

    // OR 组
    if (tok.includes('|')) {
      const g = tok.split('|').map((x) => x.trim()).filter(Boolean)
      if (g.length > 1) { if (neg) pq.exclude.push(...g); else pq.orGroups.push(g); continue }
    }

    if (neg) { pq.exclude.push(tok); continue }
    if (SOURCE_WORDS.includes(tok)) { pq.sources.push(tok); continue }
    pq.terms.push(tok)
  }
  return pq
}

// ==================== 五、题目字段预处理 ====================

// 按题目 id 缓存（从 JSON 反序列化的对象每次都是新的，WeakMap 无效，所以用 id 做键）
const fieldCache = new Map<string, Record<string, string>>()

export function fieldsOf(q: any): Record<string, string> {
  const key = q.id || ''
  const hit = key ? fieldCache.get(key) : undefined
  if (hit) return hit

  const imgs = Object.keys(q.images || {}).length
  const f: Record<string, string> = {
    content: normalizeForSearch(q.content || ''),
    analysis: normalizeForSearch(q.analysis || ''),
    answer: normalizeForSearch(q.answer || ''),
    options: normalizeForSearch((q.options || []).join(' ')),
    tags: normalizeForSearch((q.tags || []).join(' ')),
    source: normalizeForSearch(q.source || ''),
    category: normalizeForSearch(q.categoryName || ''),
    // 年份：只取标签/来源/题干前 60 字，避免解析里提到的年份污染
    _year: (String((q.tags || []).join(' ')) + ' ' + (q.source || '') + ' ' + (q.content || '').slice(0, 60))
      .match(/(?:19|20)\d{2}/g)?.join(' ') || '',
    _imgs: String(imgs),
  }
  if (key) fieldCache.set(key, f)
  return f
}

/** 清空字段缓存（题库数据变更后调用） */
export function clearFieldCache() { fieldCache.clear() }

// ==================== 六、打分与检索 ====================

export interface SearchHit {
  q: any
  score: number
  full: number
  hits: string[]
  misses: string[]
  ratio: number
}

export function searchQuestions(qs: any[], pq: ParsedQuery, opts?: { minRatio?: number }): SearchHit[] {
  const minRatio = opts?.minRatio ?? MIN_RATIO

  // 空查询 → 交给上层走"浏览模式"
  if (!pq.terms.length && !pq.orGroups.length && !pq.type &&
    pq.hasImage === undefined && !pq.year && !pq.sources.length) return []

  const needTermHit = pq.terms.length > 0 || pq.orGroups.length > 0
  const out: SearchHit[] = []

  for (const q of qs) {
    const f = fieldsOf(q)
    let score = 0, full = 0, termHits = 0
    const hits: string[] = [], misses: string[] = []

    // ① 硬过滤：排除词 + 结构性条件（题型 / 有无图）
    // 这两类不是"相关度"，是"约束"：用户说了填空就不要别的题型，说了有图就不要没图的
    if (pq.exclude.length) {
      const all = Object.values(f).join(' ')
      if (pq.exclude.some((x) => all.includes(normalizeForSearch(x)))) continue
    }
    if (pq.type && q.type !== pq.type) continue
    if (pq.hasImage !== undefined && (Number(f._imgs) > 0) !== pq.hasImage) continue

    // ② 关键词（每个独立计分）
    for (const t of pq.terms) {
      let nt = normalizeForSearch(t)
      if (!nt) continue
      full += TERM_WEIGHTS.content
      let hitLabel = t

      const anyHit = (needle: string) =>
        Object.keys(TERM_WEIGHTS).some((k) => f[k] && f[k].includes(needle))

      // 原词没命中时，才试形近字变体（省性能，也减少误命中）
      if (!anyHit(nt)) {
        for (const alt of expandHomoglyph(t)) {
          const na = normalizeForSearch(alt)
          if (na && anyHit(na)) { nt = na; hitLabel = alt + '(形近字)'; break }
        }
      }

      let best = 0, hitsN = 0
      for (const k of Object.keys(TERM_WEIGHTS)) {
        if (f[k] && f[k].includes(nt)) { best = Math.max(best, TERM_WEIGHTS[k]); hitsN++ }
      }
      if (best > 0) {
        score += best + Math.min(hitsN - 1, 3)   // 多字段命中加成（封顶 +3）
        hits.push(hitLabel); termHits++
      } else misses.push(t)
    }

    // ③ OR 组
    for (const g of pq.orGroups) {
      full += TERM_WEIGHTS.content
      const ok = g.some((x) => {
        const nx = normalizeForSearch(x)
        return nx && Object.values(f).some((v) => v && v.includes(nx))
      })
      if (ok) { score += TERM_WEIGHTS.content; hits.push(g.join('|')); termHits++ }
      else misses.push(g.join('|'))
    }

    // ④ 结构化条件（题型/有图在 ① 已硬过滤，这里只计分）
    if (pq.type) {
      full += WEIGHTS.type; score += WEIGHTS.type; hits.push(pq.type)
    }
    if (pq.hasImage !== undefined) {
      full += WEIGHTS.image; score += WEIGHTS.image
      hits.push(pq.hasImage ? '有图' : '无图')
    }
    if (pq.year) {
      full += WEIGHTS.year
      if ((f._year || '').includes(pq.year)) { score += WEIGHTS.year; hits.push(pq.year + '年') }
      else misses.push(pq.year + '年')
    }
    for (const s of pq.sources) {
      full += WEIGHTS.source
      const ns = normalizeForSearch(s)
      if (ns && (f.tags.includes(ns) || f.source.includes(ns) || f.content.includes(ns))) {
        score += WEIGHTS.source; hits.push(s)
      } else misses.push(s)
    }

    // ⑤ 三层门槛
    if (score <= 0) continue
    if (needTermHit && termHits === 0) continue
    if (full > 0 && score / full < minRatio) continue

    // ratio 只反映"要求被满足的比例"，不含下面的排序微调，且封顶 1
    // （多字段命中的小额加成可能让 score 略超 full）
    const ratio = full ? Math.min(1, score / full) : 0

    // ⑥ 短题轻微优先（避免长解析刷分）
    score += Math.max(0, 4 - (q.content || '').length / 200)

    out.push({ q, score, full: full || 1, hits, misses, ratio })
  }

  // ⑦ 匹配度优先，同分看绝对分
  out.sort((a, b) => b.ratio - a.ratio || b.score - a.score)
  return out
}
