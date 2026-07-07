import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import BasketPanel from './BasketPanel';
import { STYLE_TEMPLATES } from './types';
import PptxGenJS from 'pptxgenjs';
import './Composer.css';

// ====== 类型定义 ======
interface QuestionStyle {
  fontSize: number;
  fontColor: string;
  bold: boolean;
  backgroundColor: string;
  hasBorder: boolean;
  borderColor: string;
  borderStyle: 'solid' | 'dashed' | 'none';
  borderRadius: number;
  optionLayout: 'horizontal-4' | 'horizontal-2' | 'vertical';
  imageWidth: string;
  imageAlign: 'left' | 'center' | 'right';
  blankLines: number;
  pageBreak: boolean;
}

const DEFAULT_STYLE: QuestionStyle = {
  fontSize: 14,
  fontColor: '#333333',
  bold: false,
  backgroundColor: 'transparent',
  hasBorder: false,
  borderColor: '#f5a623',
  borderStyle: 'solid',
  borderRadius: 8,
  optionLayout: 'horizontal-4',
  imageWidth: '50%',
  imageAlign: 'center',
  blankLines: 0,
  pageBreak: false,
};

interface PaperSettings {
  title: string;
  subtitle: string;
  headerLeft: string;
  headerRight: string;
  answerMode: 'none' | 'afterEach' | 'atEnd';
}

const DEFAULT_PAPER: PaperSettings = {
  title: '数学试卷',
  subtitle: '（考试时间：120分钟  满分：150分）',
  headerLeft: '姓名：__________',
  headerRight: '得分：__________',
  answerMode: 'none',
};

interface ComposerItem {
  questionId: string;
  order: number;
  style: QuestionStyle;
  rawQuestion: any;
}

interface Props {
  questions: any[];
  basketIds: string[];
  onBasketChange: (ids: string[]) => void;
  onClearBasket?: () => void;
  apiBase: string;
}

// ====== 题型分组 ======
const TYPE_ORDER = ['单选', '多选', '填空', '解答'];
const SECTION_TITLES: Record<string, string> = {
  '单选': '一、选择题（本大题共{count}小题）',
  '多选': '二、多选题（本大题共{count}小题）',
  '填空': '三、填空题（本大题共{count}小题）',
  '解答': '四、解答题（本大题共{count}小题）',
};

function groupByType(items: ComposerItem[]): { type: string; items: ComposerItem[] }[] {
  const groups: { type: string; items: ComposerItem[] }[] = [];
  for (const t of TYPE_ORDER) {
    const matched = items.filter(q => q.rawQuestion.type === t);
    if (matched.length > 0) groups.push({ type: t, items: matched });
  }
  // 其他未分类题型
  const known = new Set(TYPE_ORDER);
  const others = items.filter(q => !known.has(q.rawQuestion.type || ''));
  if (others.length > 0) groups.push({ type: '其他', items: others });
  return groups;
}

// ====== A4 分页常量 ======
// 注：预览区采用连续流布局，A4 分页线由 CSS 画出，不做 JS 切割
// 这样保证：(1)紧凑原则——不会出现大段空白 (2)题目自然换行跨页
const A4_WIDTH = 794;   // px @ 96dpi
const A4_HEIGHT = 1123; // px @ 96dpi

// PageElement 现在只用于携带"是否强制换页"信息
interface PageElement {
  node: React.ReactNode;
  forceBreak?: boolean;   // true = 该元素前插入强制换页线
}

// ====== 简化版 LaTeX 预处理 ======
function preprocessLatex(latex: string, _questionType?: string): string {
  if (!latex || typeof latex !== 'string') return '';
  const seenImgs = new Set<string>();
  latex = latex.replace(/\\img[\{\[]\s*([^\}\]\s]+)\s*[\}\]]?/g, (match, key) => {
    if (seenImgs.has(key)) return '';
    seenImgs.add(key);
    return match;
  });
  return latex
    .replace(/\\begin\{choices\}/g, '')
    .replace(/\\end\{choices\}/g, '')
    .replace(/\\begin\{task\}/g, '')
    .replace(/\\end\{task\}/g, '')
    .replace(/\\begin\{solution\}/g, '')
    .replace(/\\end\{solution\}/g, '')
    .replace(/\\begin\{answer\}/g, '')
    .replace(/\\end\{answer\}/g, '')
    .replace(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g, '\\img{$1}')
    .replace(/\\paren\{([^}]*)\}/g, '($1)')
    .replace(/\\sqpar\{([^}]*)\}/g, '[$1]')
    .replace(/\\abs\{([^}]*)\}/g, '|$1|')
    .replace(/\\floor\{([^}]*)\}/g, '\u230A$1\u230B')
    .replace(/\\ceil\{([^}]*)\}/g, '\u2308$1\u2309')
    .replace(/\\RR/g, '\\mathbb{R}')
    .replace(/\\NN/g, '\\mathbb{N}')
    .replace(/\\ZZ/g, '\\mathbb{Z}')
    .replace(/\\QQ/g, '\\mathbb{Q}')
    .replace(/\\CC/g, '\\mathbb{C}')
    .replace(/\\grad/g, '\\nabla')
    .replace(/\\fillin(\[[^\]]*\])?\{([^}]*)\}/g, '\\underline{\\qquad}')
    .replace(/\\underline\{\\hspace\*?\{[^}]*\}\}/g, '\\underline{\\qquad}')
    .replace(/\\underline\{\s*\}/g, '\\underline{\\qquad}');
}

function ensureMathDelimiters(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let displayGroup: string[] = [];

  const flushDisplayGroup = () => {
    if (displayGroup.length === 0) return;
    if (displayGroup.length === 1) {
      result.push(`\\[${displayGroup[0]}\\]`);
    } else {
      const hasAlignment = displayGroup.some(l => /&/.test(l));
      if (hasAlignment) {
        result.push(`\\[\\begin{aligned}\n${displayGroup.join('\n')}\n\\end{aligned}\\]`);
      } else {
        result.push(`\\[${displayGroup.join(' \\\\\n')}\\]`);
      }
    }
    displayGroup = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /<[a-z][^>]*>/i.test(trimmed)) {
      flushDisplayGroup();
      result.push(line);
      continue;
    }
    // 完整包裹行：\(...\) 或 \[...\] 或 $$...$$
    if ((trimmed.startsWith('\\(') && trimmed.endsWith('\\)')) ||
        (trimmed.startsWith('\\[') && trimmed.endsWith('\\]')) ||
        (trimmed.startsWith('$$') && trimmed.endsWith('$$'))) {
      flushDisplayGroup();
      result.push(line);
      continue;
    }
    // 行内已有 \(...\) 对
    if (/\\\\\(/.test(trimmed) && /\\\\\)/.test(trimmed)) {
      flushDisplayGroup();
      result.push(line);
      continue;
    }
    // ⚠️ 关键修复：行内已有 $...$ 内联数学分隔符 → 直接保留（MathJax 原生处理）
    //   $ 符号出现偶数次说明已是完整的内联数学，不需要二次包裹
    const dollarCount = (trimmed.match(/\$/g) || []).length;
    if (dollarCount >= 2 && dollarCount % 2 === 0) {
      flushDisplayGroup();
      result.push(line);
      continue;
    }
    // 行内已含有 MathJax 分隔符，直接保留避免嵌套
    if (/\\[\(\[]/.test(trimmed)) {
      flushDisplayGroup();
      result.push(line);
      continue;
    }
    const hasMathCommand = /\\(because|therefore|frac|sqrt|sin|cos|tan|alpha|beta|gamma|delta|pi|cdot|left|right|geq|leq|neq|pm|times|overrightarrow|vec|mathbf|mathbb|text|tfrac|dfrac|sum|prod|int|lim|infty|partial|nabla|overline|underline|bar|hat|tilde|dot|ddot|quad|qquad|ln|log|exp|max|min|sup|inf|limsup|liminf|to|mapsto|Rightarrow|Leftrightarrow|forall|exists|in|notin|subset|supset|cup|cap|setminus|emptyset|varnothing|angle|triangle|sim|approx|equiv|cong|propto|perp|parallel|mid|circ|bullet|oplus|ominus|otimes|oslash|odot|bigcirc|setminus)/.test(trimmed);
    if (!hasMathCommand) {
      flushDisplayGroup();
      result.push(line);
      continue;
    }
    const hasAlignment = /&/.test(trimmed);
    const hasDisplayEnv = /\\begin\{(aligned|cases|matrix|bmatrix|pmatrix|array|gather|align|alignat|flalign|multline)\}/.test(trimmed);
    const hasLineBreak = /\\\\\\\\/.test(trimmed);
    if (hasDisplayEnv || hasAlignment || hasLineBreak) {
      displayGroup.push(trimmed);
    } else {
      flushDisplayGroup();
      result.push(`\\(${trimmed}\\)`);
    }
  }
  flushDisplayGroup();
  return result.join('\n');
}

// ====== 清理 LaTeX 残留分隔符（防止 \( 或 \) 作为裸文本显示） ======
function cleanupLatexResidue(text: string): string {
  // 策略: 逐字符扫描，平衡 \(...\) 对，移除多余的 \)，补全缺失的 \)
  // 同时处理行内 \(...\) 和块级 \[...\] 
  let result = '';
  let i = 0;
  while (i < text.length) {
    // 检测 \( 
    if (text[i] === '\\' && i + 1 < text.length && text[i + 1] === '(') {
      // 找到对应的 \)
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '\\' && j + 1 < text.length && text[j + 1] === ')') {
          depth--;
          if (depth === 0) {
            // 完整的一对 \(...\)，保留
            result += text.substring(i, j + 2);
            i = j + 2;
            break;
          }
          j += 2;
        } else if (text[j] === '\\' && j + 1 < text.length && text[j + 1] === '(') {
          depth++;
          j += 2;
        } else {
          j++;
        }
      }
      if (depth > 0) {
        // 没有找到匹配的 \)，把这个 \( 当作普通文本
        result += '(';
        i += 2;
      }
      continue;
    }
    // 检测 \)
    if (text[i] === '\\' && i + 1 < text.length && text[i + 1] === ')') {
      // 孤立的 \)，没有前面的 \(，当作普通文本 )
      result += ')';
      i += 2;
      continue;
    }
    // 检测 \[
    if (text[i] === '\\' && i + 1 < text.length && text[i + 1] === '[') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '\\' && j + 1 < text.length && text[j + 1] === ']') {
          depth--;
          if (depth === 0) {
            result += text.substring(i, j + 2);
            i = j + 2;
            break;
          }
          j += 2;
        } else if (text[j] === '\\' && j + 1 < text.length && text[j + 1] === '[') {
          depth++;
          j += 2;
        } else {
          j++;
        }
      }
      if (depth > 0) {
        result += '[';
        i += 2;
      }
      continue;
    }
    // 检测 \]
    if (text[i] === '\\' && i + 1 < text.length && text[i + 1] === ']') {
      result += ']';
      i += 2;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}

// ====== MathJax 渲染组件 ======
function MathJaxBlock({ html, key_, style, isSelected, onClick }: {
  html: string;
  key_: string;
  style: QuestionStyle;
  isSelected: boolean;
  onClick?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let timer: number;
    const checkReady = () => {
      if ((window as any).MathJax?.typesetPromise) {
        setReady(true);
      } else {
        timer = window.setTimeout(checkReady, 200);
      }
    };
    checkReady();
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!containerRef.current || !ready) return;
    const doRender = () => {
      try {
        containerRef.current!.innerHTML = html;
        (window as any).MathJax.typesetPromise([containerRef.current!]).catch((err: any) => {
          console.error('MathJax typeset error:', err);
        });
      } catch (err: any) {
        console.error('MathJaxBlock render error:', err);
      }
    };
    doRender();
    // ⚠️ 500ms 后二次渲染，防止首次 MathJax 残留 $ 代码
    const retryTimer = setTimeout(doRender, 500);
    return () => clearTimeout(retryTimer);
  }, [html, ready]);

  // 是否用户显式设置了自定义样式（背景非透明 或 开了边框）
  const hasCustomStyle = style.hasBorder || (style.backgroundColor && style.backgroundColor !== 'transparent');

  const borderStyle = isSelected
    ? '2px solid #534AB7'
    : style.hasBorder
      ? `${style.borderStyle === 'dashed' ? '1.5px' : '2px'} ${style.borderStyle} ${style.borderColor}`
      : 'none';

  return (
    <div
      ref={containerRef}
      id={`qblock-${key_}`}
      className="question-block"
      onClick={onClick}
      style={{
        padding: hasCustomStyle ? '10px 14px' : '8px 0',
        borderRadius: isSelected ? 6 : hasCustomStyle ? style.borderRadius : 0,
        cursor: onClick ? 'pointer' : 'default',
        fontSize: style.fontSize,
        color: style.fontColor,
        fontWeight: style.bold ? 700 : 400,
        border: borderStyle,
        background: style.backgroundColor || 'transparent',
        transition: 'all 0.15s',
        marginBottom: 16,
        lineHeight: 1.8,
      }}
    />
  );
}

// ====== 构建单题完整 HTML ======
function buildQuestionHTML(
  item: ComposerItem,
  questionNumber: number,
  apiBase: string,
  paperSettings: PaperSettings,
): string {
  const q = item.rawQuestion;
  const style = item.style;

  let html = '';

  // 预处理 LaTeX
  let body = preprocessLatex(q.content || q.title || '', q.type);
  body = ensureMathDelimiters(body);
  // ⚠️ 清理残留分隔符，防止 \( 或 \) 作为裸文本显示
  body = cleanupLatexResidue(body);

  // 处理 \img{key} -> <img>
  body = body.replace(/\\img[\{\[]\s*([^\}\]\s]+)\s*[\}\]]?/g, (_match: string, key: string) => {
    const images = q.images || {};
    const url = images[key];
    let fullUrl: string;
    if (url) {
      fullUrl = url.startsWith('http') ? url : `${apiBase}${url.startsWith('/') ? '' : '/'}${url}`;
    } else {
      fullUrl = `${apiBase}/uploads/images/${key}`;
    }
    const w = style.imageWidth;
    const align = style.imageAlign;
    return `<div class="question-image-wrapper" style="display:flex;justify-content:${align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center'};margin:10px 0;"><img src="${fullUrl}" alt="diagram" onerror="this.style.display='none';var s=this.nextElementSibling;if(s)s.style.display='block';" style="display:block;max-width:${w};height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);" /><span style="display:none;color:#e74c3c;font-size:12px;padding:8px 0;">[图片: ${key} 未找到]</span></div>`;
  });

  // 处理 \underline 填空
  body = body.replace(/\\underline\{\\qquad\}/g, '<span class="fillin-blank"></span>');
  body = body.replace(/\\underline\{\\hspace\*?\{[^}]*\}\}/g, '<span class="fillin-blank"></span>');
  body = body.replace(/\\underline\{\s*\}/g, '<span class="fillin-blank"></span>');

  // 换行处理
  body = body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
  if (!body.startsWith('<p>')) body = `<p>${body}</p>`;

  // 题号 + 题干
  html += `<p><strong class="question-number">${questionNumber}.</strong>${body.replace(/^<p>/, '').replace(/<\/p>$/, '')}</p>`;

  // 选项（CSS Grid 排版）
  if (q.options && q.options.length > 0 && (q.type === '单选' || q.type === '多选')) {
    const cols = style.optionLayout === 'horizontal-4' ? 4 : style.optionLayout === 'horizontal-2' ? 2 : 1;
    html += `<div class="preview-options grid-col-${cols}">`;
    q.options.forEach((opt: string, oi: number) => {
      const letter = String.fromCharCode(65 + oi);
      let optProcessed = preprocessLatex(opt, q.type);
      optProcessed = ensureMathDelimiters(optProcessed);
      optProcessed = cleanupLatexResidue(optProcessed);
      html += `<span class="option-item">${letter}. ${optProcessed}</span>`;
    });
    html += '</div>';
  }

  // 答案显示（每题后）
  if (paperSettings.answerMode === 'afterEach') {
    const answer = q.answer || q.answerContent || '';
    let analysis = preprocessLatex(q.analysis || '', q.type);
    analysis = ensureMathDelimiters(analysis);
    analysis = cleanupLatexResidue(analysis);
    html += `<div class="answer-inline"><strong>【答案】</strong>${answer}`;
    if (analysis) html += `<br><strong>【解析】</strong>${analysis}`;
    html += '</div>';
  }

  // 空白行
  if (style.blankLines > 0) {
    html += `<div style="height:${style.blankLines * 1.5}em;" class="blank-space"></div>`;
  }

  return html;
}

// ====== 父组件 ======
export default function ExamComposer({ questions, basketIds, onBasketChange, onClearBasket, apiBase }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [styles, setStyles] = useState<Record<string, QuestionStyle>>({});
  const [paperSettings, setPaperSettings] = useState<PaperSettings>(DEFAULT_PAPER);
  const [editingPaper, setEditingPaper] = useState(false);

  // 按 basketIds 顺序构建列表
  const basketList: ComposerItem[] = useMemo(() => {
    return basketIds
      .map((id, i) => {
        const q = questions.find(q => q.id === id);
        if (!q) return null;
        return {
          questionId: q.id,
          order: i,
          style: styles[q.id] || DEFAULT_STYLE,
          rawQuestion: q,
        };
      })
      .filter(Boolean) as ComposerItem[];
  }, [basketIds, questions, styles]);

  // 题型分组
  const typedGroups = useMemo(() => groupByType(basketList), [basketList]);

  const getStyle = useCallback((id: string): QuestionStyle => {
    return styles[id] || DEFAULT_STYLE;
  }, [styles]);

  const updateStyle = useCallback((id: string, patch: Partial<QuestionStyle>) => {
    setStyles(prev => ({
      ...prev,
      [id]: { ...getStyle(id), ...patch },
    }));
  }, [getStyle]);

  // ====== 应用模板到当前题 ======
  const applyTemplate = useCallback((templateIdx: number) => {
    if (!selectedId) return;
    const tpl = STYLE_TEMPLATES[templateIdx];
    if (!tpl) return;
    updateStyle(selectedId, { ...tpl.style });
  }, [selectedId, updateStyle]);

  // ====== 应用当前题样式到全部题目 ======
  const applyCurrentStyleToAll = useCallback(() => {
    if (!selectedId) return;
    const currentStyle = getStyle(selectedId);
    const newStyles: Record<string, QuestionStyle> = {};
    basketList.forEach(item => {
      newStyles[item.questionId] = {
        ...DEFAULT_STYLE,
        ...currentStyle,
      };
    });
    setStyles(prev => ({ ...prev, ...newStyles }));
  }, [selectedId, getStyle, basketList]);

  // ====== 重置全部样式为默认 ======
  const resetAllStyles = useCallback(() => {
    if (!window.confirm('确定要重置全部题目的样式吗？所有自定义边框、背景色将被清除。')) return;
    setStyles({});
  }, []);

  // ====== 题型内排序（直接交换 fromIdx 和 toIdx 位置） ======
  // ⚠️ 使用 ref 避免 handleReorder 的 useCallback 闭包捕获陈旧 basketIds
  const basketIdsRef = useRef(basketIds);
  basketIdsRef.current = basketIds;
  const [dragVersion, setDragVersion] = useState(0);  // 递增触发器

  const handleReorder = useCallback((fromIdx: number, toIdx: number) => {
    const curIds = basketIdsRef.current;
    console.log('[handleReorder] from:', fromIdx, 'to:', toIdx, 'ids:', curIds);
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= curIds.length || toIdx >= curIds.length) {
      console.log('[handleReorder] invalid indices');
      return;
    }
    const newIds = [...curIds];
    const [removed] = newIds.splice(fromIdx, 1);
    newIds.splice(toIdx, 0, removed);
    console.log('[handleReorder] newIds:', newIds);
    onBasketChange(newIds);
    setDragVersion(v => v + 1);  // 触发强制重渲染
  }, [onBasketChange]);

  const handleRemove = useCallback((id: string) => {
    onBasketChange(basketIds.filter(bid => bid !== id));
    if (selectedId === id) setSelectedId(null);
  }, [basketIds, onBasketChange, selectedId]);

  const selectedQuestion = selectedId
    ? basketList.find(i => i.questionId === selectedId) : null;
  const selectedStyle = selectedId ? getStyle(selectedId) : DEFAULT_STYLE;

  // ====== 构建元素列表（含题型标题 + 题目 + 答案区） ======
  // 连续流方案：不再 JS 分页，而是把所有元素放到一个连续容器里
  // 强制换页(pageBreak)的题目会在前面加一个"CSS分页线"
  const buildAllElements = (): PageElement[] => {
    const elements: PageElement[] = [];
    let globalNum = 1;

    typedGroups.forEach((group, gi) => {
      // 分组标题
      const sectionTitle = (SECTION_TITLES[group.type] || group.type).replace('{count}', String(group.items.length));
      elements.push({
        node: <div key={`section-${gi}`} className="paper-section-title">{sectionTitle}</div>,
      });

      group.items.forEach(item => {
        const num = globalNum++;
        const html = buildQuestionHTML(item, num, apiBase, paperSettings);
        const isSelected = item.questionId === selectedId;
        const hasBreak = item.style.pageBreak;
        // ⚠️ key 包含 num，拖拽换序后序号变化，React 强制重新创建组件，MathJax 重新渲染
        const nodeKey = `${num}-${item.questionId}`;
        elements.push({
          node: (
            <MathJaxBlock
              key={nodeKey}
              key_={nodeKey}
              html={html}
              style={item.style}
              isSelected={isSelected}
              onClick={() => setSelectedId(item.questionId)}
            />
          ),
          forceBreak: hasBreak,
        });
      });
    });

    // 答案末尾区
    if (paperSettings.answerMode === 'atEnd') {
      elements.push({
        node: <div key="answer-section-title" className="paper-section-title">参考答案</div>,
      });
      let aNum = 1;
      typedGroups.forEach(group => {
        group.items.forEach(item => {
          const q = item.rawQuestion;
          const answer = q.answer || q.answerContent || '';
          let analysis = preprocessLatex(q.analysis || '', q.type);
          analysis = ensureMathDelimiters(analysis);
          analysis = cleanupLatexResidue(analysis);
          const ahtml = `<p><strong>${aNum++}.</strong> ${answer}</p>` +
            (analysis ? `<p style="padding-left:24px;">${analysis}</p>` : '');
          elements.push({
            node: (
              <MathJaxBlock key={`a-${item.questionId}`} key_={`a-${item.questionId}`}
                html={ahtml} style={DEFAULT_STYLE} isSelected={false} />
            ),
          });
        });
      });
    }

    return elements;
  };

  // 把元素列表转为带"强制换页线"的渲染节点列表
  const buildRenderNodes = (elements: PageElement[]): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    elements.forEach((el, idx) => {
      if (el.forceBreak && idx > 0) {
        // 插入强制分页线（屏幕上显示为虚线，打印时 CSS break）
        nodes.push(
          <div key={`break-${idx}`} className="forced-page-break" title="强制换页">
            <span>— 强制换页 —</span>
          </div>
        );
      }
      nodes.push(el.node);
    });
    return nodes;
  };  // 构建渲染节点（连续流，不分页）
  // ⚠️ 去掉 useMemo，每次渲染都重新计算，确保拖拽排序后中间栏实时更新
  const renderNodes = buildRenderNodes(buildAllElements());

  // ====== 导出函数 ======
  const handleExportPDF = useCallback(async () => {
    if (basketIds.length === 0) return alert('试卷篮为空，请先添加题目');
    try {
      // 固定参数：教师版，题目在前，答案在末尾
      const filename = `数学试卷_教师版_A4.pdf`;
      const itemsPayload = basketList.map(item => ({
        id: item.rawQuestion.id,
        style: item.style
      }));
      const res = await fetch(`${apiBase}/api/generate-paper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: paperSettings.title,
          questionIds: basketIds,
          items: itemsPayload,
          includeAnswer: true,
          includeAnalysis: true,
          answerAtEnd: true,
          format: 'pdf',
          paperSize: 'a4',
        }),
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText || '服务器错误');
      }
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const data = await res.json();
        throw new Error(data.error || '未知错误');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      alert(`PDF 下载成功！共 ${basketIds.length} 道题（教师版）`);
    } catch (err: any) {
      alert('导出失败：' + (err.message || '未知错误'));
    }
  }, [basketIds, basketList, apiBase, paperSettings.title]);

  const handleExportLaTeX = useCallback(async () => {
    if (basketIds.length === 0) return alert('试卷篮为空，请先添加题目');
    try {
      // 固定参数：教师版，题目在前，答案在末尾
      const filename = `数学试卷_教师版_A4.zip`;
      const itemsPayload = basketList.map(item => ({
        id: item.rawQuestion.id,
        style: item.style
      }));
      const res = await fetch(`${apiBase}/api/generate-paper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: paperSettings.title,
          questionIds: basketIds,
          items: itemsPayload,
          includeAnswer: true,
          includeAnalysis: true,
          answerAtEnd: true,
          format: 'zip',
          paperSize: 'a4',
        }),
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText || '服务器错误');
      }
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const data = await res.json();
        throw new Error(data.error || '未知错误');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      alert(`LaTeX 源码包下载成功！共 ${basketIds.length} 道题（教师版）`);
    } catch (err: any) {
      alert('导出失败：' + (err.message || '未知错误'));
    }
  }, [basketIds, basketList, apiBase, paperSettings.title]);

  // ====== PPTX 导出（从 PDF 截图：100% 可靠，公式/图片/样式完美） ======
  const handleExportPPTX = useCallback(async () => {
    if (basketIds.length === 0) return alert('试卷篮为空，请先添加题目');

    const pdfjsLib = (window as any).pdfjsLib;
    if (!pdfjsLib?.getDocument) {
      alert('pdf.js 未加载，请刷新页面后重试');
      return;
    }

    try {
      // ====== Step 1: 从后端生成「每题一页」的 16:9 PDF（教师版）======
      const res = await fetch(`${apiBase}/api/generate-paper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: paperSettings.title,
          questionIds: basketIds,
          items: basketList.map(item => ({ id: item.questionId, style: item.style })),
          includeAnswer: true,
          includeAnalysis: true,
          answerAtEnd: true,
          format: 'pdf',
          pptxMode: true
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: '请求失败' }));
        throw new Error(errData.error || 'PDF 生成失败（HTTP ' + res.status + '）');
      }

      const pdfBuffer = await res.arrayBuffer();
      if (pdfBuffer.byteLength < 100) {
        throw new Error('生成的 PDF 文件异常（过小）');
      }

      // ====== Step 2: pdf.js 逐页渲染为图片 ======
      const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
      const pdf = await loadingTask.promise;
      const totalPages = pdf.numPages;

      if (totalPages < 1) {
        throw new Error('PDF 没有页面');
      }

      const pageImages: string[] = [];
      for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 }); // 2x 分辨率
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建 canvas context');
        await page.render({ canvasContext: ctx, viewport }).promise;
        pageImages.push(canvas.toDataURL('image/png'));
      }

      // ====== Step 3: 创建 PPTX ======
      const grouped = groupByType(basketList);
      const totalQ = basketIds.length;
      const pptx = new PptxGenJS();
      pptx.defineLayout({ name: 'CUSTOM_16x9', width: 13.333, height: 7.5 });
      pptx.layout = 'CUSTOM_16x9';
      pptx.author = 'Math Website';
      pptx.title = paperSettings.title || '数学试卷';

      // 封面页
      {
        const cover = pptx.addSlide();
        cover.background = { fill: '534AB7' };
        cover.addText(paperSettings.title || '数学试卷', {
          x: 1, y: 2, w: 11, h: 1.5, fontSize: 40, color: 'FFFFFF', bold: true,
          align: 'center', fontFace: 'Microsoft YaHei'
        });
        if (paperSettings.subtitle) {
          cover.addText(paperSettings.subtitle, {
            x: 1, y: 3.6, w: 11, h: 0.8, fontSize: 18, color: 'DDDDFF',
            align: 'center', fontFace: 'Microsoft YaHei'
          });
        }
        cover.addText(`${totalQ} 道题 · ${new Date().toLocaleDateString('zh-CN')}`, {
          x: 1, y: 4.6, w: 11, h: 0.6, fontSize: 14, color: 'BBBBFF',
          align: 'center', fontFace: 'Microsoft YaHei'
        });
      }

      let pageIdx = 0; // 对应 PDF 页面索引（0-based）
      for (const group of grouped) {
        // 题型分隔页
        {
          const sec = pptx.addSlide();
          sec.background = { fill: 'F0EEFF' };
          sec.addText(group.type || '其他', {
            x: 1, y: 2.8, w: 11, h: 1.5, fontSize: 36, color: '534AB7', bold: true,
            align: 'center', fontFace: 'Microsoft YaHei'
          });
          sec.addText(`本大题共 ${group.items.length} 小题`, {
            x: 1, y: 4.2, w: 11, h: 0.6, fontSize: 16, color: '8888AA',
            align: 'center', fontFace: 'Microsoft YaHei'
          });
        }

        for (const _item of group.items) {
          if (pageIdx >= pageImages.length) break;
          const dataUrl = pageImages[pageIdx];
          const slide = pptx.addSlide();
          slide.addImage({ data: dataUrl, x: 0, y: 0, w: 13.333, h: 7.5 });
          pageIdx++;
        }
      }

      // 结尾页
      {
        const end = pptx.addSlide();
        end.background = { fill: 'F0EEFF' };
        end.addText('试题结束', {
          x: 1, y: 3, w: 11, h: 1, fontSize: 30, color: '534AB7', bold: true,
          align: 'center', fontFace: 'Microsoft YaHei'
        });
      }

      // ====== Step 4: 下载 ======
      const filename = `数学试卷_${paperSettings.title || '学生版'}.pptx`;
      await pptx.writeFile({ fileName: filename });
      alert(`PPTX 导出成功！共 ${totalQ} 道题（${totalPages} 页 PDF）\n直接导入希沃白板即可，公式和图片完整呈现`);
    } catch (err: any) {
      console.error('[PPTX] 导出失败:', err);
      alert('PPTX 导出失败：' + (err.message || '未知错误'));
    }
  }, [basketIds, basketList, apiBase, paperSettings]);

  return (
    <div className="composer-wrapper">
      {/* ========== 左侧栏：选题篮 ========== */}
      <div className="composer-left">
        <div className="composer-left-header">
          选题篮 ({basketList.length})
          {basketList.length > 0 && (
            <button
              onClick={onClearBasket}
              style={{
                background: 'none', border: 'none', color: '#c33',
                cursor: 'pointer', fontSize: 12,
              }}
            >清空</button>
          )}
        </div>
        <div className="composer-left-list">
          <BasketPanel
            items={basketList}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onReorder={handleReorder}
            onRemove={handleRemove}
          />
        </div>
      </div>

      {/* ========== 中间栏：WYSIWYG 试卷预览（连续流 A4） ========== */}
      <div className="composer-center">
        <div className="composer-center-toolbar">
          <span style={{ fontSize: 14, fontWeight: 600 }}>试卷预览</span>
          <span style={{ fontSize: 12, color: '#999' }}>
            {basketList.length} 题
          </span>
        </div>
        <div className="composer-center-preview">
          {basketList.length === 0 ? (
            <div className="paper-sheet" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 400 }}>
              <p style={{ color: '#999', textAlign: 'center' }}>
                从试题库添加题目到此预览
              </p>
            </div>
          ) : (
            <div className="paper-sheet" key={`sheet-${dragVersion}`}>
              {/* 页眉 */}
              <div className="paper-page-header">
                <div className="header-row">
                  <span>{paperSettings.headerLeft}</span>
                  <span>{paperSettings.headerRight}</span>
                </div>
                <div className="paper-title">{paperSettings.title}</div>
                {paperSettings.subtitle && (
                  <div className="paper-subtitle">{paperSettings.subtitle}</div>
                )}
              </div>

              {/* 内容区（连续流，自然分页） */}
              <div className="paper-sheet-content">
                {renderNodes}
              </div>

              {/* 页脚 */}
              <div className="paper-page-footer">
                （试卷结束）
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ========== 右侧栏：属性配置 ========== */}
      <div className="composer-right">
        <div className="composer-right-header">
          属性配置
          <button
            onClick={() => setEditingPaper(!editingPaper)}
            style={{
              background: editingPaper ? '#f0eeff' : '#f5f5f5',
              border: '0.5px solid #ddd', borderRadius: 4,
              padding: '3px 10px', fontSize: 12, cursor: 'pointer',
              color: editingPaper ? '#534AB7' : '#666',
            }}
          >试卷设置</button>
        </div>
        <div className="composer-right-body">

          {/* ===== 试卷设置面板 ===== */}
          {editingPaper && (
            <div style={{ marginBottom: 20 }}>
              <div className="property-group">
                <div className="property-group-title">试卷设置</div>
                <div className="property-row">
                  <label>标题</label>
                  <input type="text" value={paperSettings.title}
                    onChange={e => setPaperSettings(prev => ({ ...prev, title: e.target.value }))}
                    style={{ width: '100%', padding: '4px 8px', border: '0.5px solid #ddd', borderRadius: 4, fontSize: 13 }} />
                </div>
                <div className="property-row">
                  <label>副标题</label>
                  <input type="text" value={paperSettings.subtitle}
                    onChange={e => setPaperSettings(prev => ({ ...prev, subtitle: e.target.value }))}
                    style={{ width: '100%', padding: '4px 8px', border: '0.5px solid #ddd', borderRadius: 4, fontSize: 13 }} />
                </div>
                <div className="property-row">
                  <label>页眉左</label>
                  <input type="text" value={paperSettings.headerLeft}
                    onChange={e => setPaperSettings(prev => ({ ...prev, headerLeft: e.target.value }))}
                    style={{ width: '100%', padding: '4px 8px', border: '0.5px solid #ddd', borderRadius: 4, fontSize: 13 }} />
                </div>
                <div className="property-row">
                  <label>页眉右</label>
                  <input type="text" value={paperSettings.headerRight}
                    onChange={e => setPaperSettings(prev => ({ ...prev, headerRight: e.target.value }))}
                    style={{ width: '100%', padding: '4px 8px', border: '0.5px solid #ddd', borderRadius: 4, fontSize: 13 }} />
                </div>
              </div>

              <div className="property-group">
                <div className="property-group-title">答案显示</div>
                <div className="property-row">
                  <select value={paperSettings.answerMode}
                    onChange={e => setPaperSettings(prev => ({ ...prev, answerMode: e.target.value as PaperSettings['answerMode'] }))}
                    style={{ width: '100%' }}>
                    <option value="none">不显示答案</option>
                    <option value="afterEach">每题后面显示</option>
                    <option value="atEnd">试卷末尾显示</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* ===== 题目属性面板 ===== */}
          {!editingPaper && selectedQuestion ? (
            <div>
              <p style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                {selectedQuestion.rawQuestion.title?.slice(0, 40) || '(无标题)'}
              </p>
              <p style={{ color: '#999', fontSize: 12, marginBottom: 16 }}>
                {selectedQuestion.rawQuestion.type || '选择题'} · 难度{selectedQuestion.rawQuestion.difficulty || '未知'}
              </p>

              {/* 样式模板 */}
              <div className="property-group">
                <div className="property-group-title">样式模板</div>
                <div className="template-grid">
                  {STYLE_TEMPLATES.map((tpl, idx) => (
                    <button
                      key={tpl.name}
                      className="template-btn"
                      title={tpl.name}
                      onClick={() => applyTemplate(idx)}
                      style={{
                        background: tpl.style.backgroundColor || '#fff',
                        borderColor: tpl.style.borderColor || '#ddd',
                      }}
                    >
                      <span className="template-dot" style={{ background: tpl.style.borderColor || '#ddd' }} />
                      <span className="template-name">{tpl.name}</span>
                    </button>
                  ))}
                </div>
                <button
                  className="template-copy-all"
                  onClick={applyCurrentStyleToAll}
                  disabled={!selectedId}
                >
                  📋 复制当前样式到全部题目
                </button>
                <button
                  className="template-copy-all"
                  onClick={resetAllStyles}
                  style={{ marginTop: 6, color: '#c33', borderColor: '#fcc', background: '#fff5f5' }}
                >
                  🔄 重置全部样式
                </button>
              </div>

              {/* 字体设置 */}
              <div className="property-group">
                <div className="property-group-title">字体设置</div>
                <div className="property-row">
                  <label>字号</label>
                  <input type="number" value={selectedStyle.fontSize} min={10} max={24}
                    onChange={e => updateStyle(selectedId!, { fontSize: Number(e.target.value) })} />
                </div>
                <div className="property-row">
                  <label>字体颜色</label>
                  <input type="color" value={selectedStyle.fontColor}
                    onChange={e => updateStyle(selectedId!, { fontColor: e.target.value })} />
                </div>
                <div className="property-row">
                  <label>加粗</label>
                  <button className={`toggle ${selectedStyle.bold ? 'on' : 'off'}`}
                    onClick={() => updateStyle(selectedId!, { bold: !selectedStyle.bold })} />
                </div>
              </div>

              {/* 框线设置 */}
              <div className="property-group">
                <div className="property-group-title">框线设置</div>
                <div className="property-row">
                  <label>边框</label>
                  <button className={`toggle ${selectedStyle.hasBorder ? 'on' : 'off'}`}
                    onClick={() => updateStyle(selectedId!, { hasBorder: !selectedStyle.hasBorder })} />
                </div>
                {selectedStyle.hasBorder && (
                  <div className="property-row">
                    <label>边框颜色</label>
                    <input type="color" value={selectedStyle.borderColor}
                      onChange={e => updateStyle(selectedId!, { borderColor: e.target.value })} />
                  </div>
                )}
              </div>

              {/* 选项排列（仅选择题） */}
              {(selectedQuestion.rawQuestion.type === '单选' || selectedQuestion.rawQuestion.type === '多选') && (
                <div className="property-group">
                  <div className="property-group-title">选项排列</div>
                  <div className="property-row">
                    <select value={selectedStyle.optionLayout}
                      onChange={e => updateStyle(selectedId!, {
                        optionLayout: e.target.value as 'horizontal-4' | 'horizontal-2' | 'vertical'
                      })}
                      style={{ width: '100%' }}>
                      <option value="horizontal-4">一行4个（A B C D）</option>
                      <option value="horizontal-2">一行2个（A B / C D）</option>
                      <option value="vertical">竖排（每行一个）</option>
                    </select>
                  </div>
                </div>
              )}

              {/* 题目间距 */}
              <div className="property-group">
                <div className="property-group-title">题目间距</div>
                <div className="property-row">
                  <label>空白行数</label>
                  <input type="number" value={selectedStyle.blankLines} min={0} max={20}
                    onChange={e => updateStyle(selectedId!, { blankLines: Number(e.target.value) })} />
                </div>
                <div className="property-row">
                  <label>题前分页</label>
                  <button className={`toggle ${selectedStyle.pageBreak ? 'on' : 'off'}`}
                    onClick={() => updateStyle(selectedId!, { pageBreak: !selectedStyle.pageBreak })} />
                </div>
              </div>

              {/* 图片设置 */}
              {selectedQuestion.rawQuestion.images && Object.keys(selectedQuestion.rawQuestion.images).length > 0 && (
                <div className="property-group">
                  <div className="property-group-title">图片设置</div>
                  <div className="property-row">
                    <label>图片宽度</label>
                    <select value={selectedStyle.imageWidth}
                      onChange={e => updateStyle(selectedId!, { imageWidth: e.target.value })}
                      style={{ width: '100%' }}>
                      <option value="25%">25%</option>
                      <option value="35%">35%</option>
                      <option value="50%">50%（默认）</option>
                      <option value="75%">75%</option>
                      <option value="100%">100%</option>
                    </select>
                  </div>
                  <div className="property-row">
                    <label>对齐方式</label>
                    <select value={selectedStyle.imageAlign}
                      onChange={e => updateStyle(selectedId!, { imageAlign: e.target.value as 'left' | 'center' | 'right' })}
                      style={{ width: '100%' }}>
                      <option value="left">左对齐</option>
                      <option value="center">居中</option>
                      <option value="right">右对齐</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
          ) : !editingPaper ? (
            <div className="property-empty">
              <p>请先在左侧或中间</p>
              <p>选中一道题目</p>
              <p style={{ fontSize: 12, color: '#aaa', marginTop: 8 }}>
                或点"试卷设置"编辑全局参数
              </p>
            </div>
          ) : null}
        </div>

        {/* 导出按钮 */}
        <div className="composer-right-footer">
          <button className="btn-export btn-export-primary" onClick={handleExportPDF}>
            导出 PDF
          </button>
          <button className="btn-export btn-export-secondary" onClick={handleExportLaTeX}>
            导出 LaTeX
          </button>
          <button className="btn-export btn-export-pptx" onClick={handleExportPPTX}>
            导出 PPTX (16:9)
          </button>
        </div>
      </div>
    </div>
  );
}
