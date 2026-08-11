import JSZip from 'jszip';
import { supabase } from './supabase';
import { toFrontendQuestion } from './db';

const LATEX_PREAMBLE = `% !TEX program = xelatex
\\documentclass[twocolumn]{exam}
\\usepackage{ctex}
\\usepackage{amsmath,amsfonts,amssymb}
\\usepackage{tikz}
\\usepackage{graphicx}
\\usepackage[table,xcdraw,svgnames,HTML]{xcolor}
\\usepackage{geometry}
\\graphicspath{{./images/}}
\\usepackage{tcolorbox}
\\tcbuselibrary{breakable,skins}
\\geometry{paperwidth=364mm,paperheight=257mm,left=1cm,right=1cm,top=0.8cm,bottom=0.8cm}
\\renewcommand{\\solutiontitle}{\\noindent\\textbf{【解析】}\\enspace}
\\SolutionEmphasis{}
\\unframedsolutions
\\footer{}{\\thepage}{}
\\noprintanswers
\\begin{document}
\\noindent 姓名：\\rule{2.5cm}{0.4pt}\\hfill 得分：\\rule{2cm}{0.4pt}
\\begin{center}
\\textbf{\\Large __TITLE__}
\\small （考试时间：120分钟\\quad 满分：150分）
\\end{center}
\\begin{questions}
`;

const LATEX_POSTAMBLE = `\\end{questions}
__ANSWERS__
\\end{document}`;

function questionToLatex(q: any, index: number): string {
  const label = index + 1;
  let body = q.content || '';

  // Clean HTML tags from exam question content
  body = body.replace(/<img[^>]*>/gi, '[图]');
  body = body.replace(/<[^>]+>/g, '');

  // Convert \\img{key} to \\includegraphics if we have the URL
  const images = q.images || {};
  body = body.replace(/\\img\{([^}]+)\}/g, (_, key) => {
    const url = images[key];
    if (url) {
      const filename = url.split('/').pop()?.split('?')[0] || key;
      return `\\includegraphics[width=0.5\\linewidth]{images/${filename}}`;
    }
    return `% [图片 ${key} 未找到]`;
  });

  let latex = '';
  const type = q.type || '解答';

  if (type === '单选' || type === '多选') {
    latex += `\\question[${label}] ${body}\n`;
    latex += `\\begin{choices}\n`;
    const options = q.options || [];
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    options.forEach((opt: string, i: number) => {
      latex += `  \\choice ${opt}\n`;
    });
    latex += `\\end{choices}\n`;
  } else if (type === '填空') {
    latex += `\\question[${label}] ${body}\n`;
  } else {
    latex += `\\question[${label}] ${body}\n`;
  }

  return latex;
}

function questionToAnswer(q: any, index: number): string {
  const answer = q.answer || '';
  const analysis = q.analysis || q.solution || '';
  if (!answer && !analysis) return '';
  let latex = `\\begin{solution}[${index + 1}]\n`;
  if (answer) latex += `${answer}\n`;
  if (analysis) latex += `\\textbf{解析：}${analysis}\n`;
  latex += `\\end{solution}\n`;
  return latex;
}

export async function generatePaperClient(
  questionIds: string[],
  title: string,
  includeAnswer: boolean,
  includeAnalysis: boolean
): Promise<Blob> {
  // Fetch questions from Supabase
  const questions: any[] = [];
  const ids = [...new Set(questionIds)];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { data } = await supabase.from('math_questions').select('*').in('id', batch);
    if (data) questions.push(...data);
  }

  // Sort by type
  const typeOrder: Record<string, number> = { '单选': 1, '多选': 2, '填空': 3, '解答': 4 };
  questions.sort((a, b) => (typeOrder[a.type] || 99) - (typeOrder[b.type] || 99));

  // Generate LaTeX
  let latex = LATEX_PREAMBLE.replace('__TITLE__', title || '数学试卷');
  const answerBlocks: string[] = [];

  questions.forEach((q, idx) => {
    const frontQ = toFrontendQuestion(q);
    latex += questionToLatex(frontQ, idx);
    if (includeAnswer || includeAnalysis) {
      answerBlocks.push(questionToAnswer(frontQ, idx));
    }
  });

  if (answerBlocks.length > 0) {
    latex = latex.replace('__ANSWERS__',
      '\\newpage\n\\printanswers\n\\section*{参考答案}\n\\begin{questions}\n' +
      answerBlocks.join('\n') +
      '\\end{questions}'
    );
  } else {
    latex = latex.replace('__ANSWERS__', '');
  }

  latex += LATEX_POSTAMBLE;

  // Create ZIP
  const zip = new JSZip();
  const suffix = includeAnswer ? (includeAnalysis ? '_教师版含解析' : '_教师版') : '_学生版';
  zip.file(`数学试卷${suffix}.tex`, latex);

  // Add images
  const imageSet = new Map<string, string>();
  questions.forEach(q => {
    const imgs = q.image ? (typeof q.image === 'string' ? JSON.parse(q.image) : q.image) : {};
    Object.values(imgs).forEach((url: any) => {
      const name = String(url).split('/').pop()?.split('?')[0] || 'img';
      if (String(url).startsWith('http')) {
        imageSet.set(name, String(url));
      }
    });
  });

  if (imageSet.size > 0) {
    const imgFolder = zip.folder('images');
    for (const [name, url] of imageSet) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const blob = await res.blob();
          imgFolder!.file(name, blob);
        }
      } catch { /* skip failed images */ }
    }
  }

  return zip.generateAsync({ type: 'blob' });
}

// ===== 客户端 PDF 生成（GitHub Pages 无服务器时用浏览器渲染）=====

// 简化预处理：只做安全清理，保留数学定界符和 LaTeX 环境给 MathJax 渲染
function preprocessForPdf(latex: string, images: Record<string, string>): string {
  if (!latex) return ''
  let text = latex
  // 只清理 MathJax 无法处理或会破坏 $$ 块的容器环境
  text = text.replace(/\begin\{minipage\}(\[[^\]]*\])?\{[^}]*\}/g, '')
  text = text.replace(/\end\{minipage\}/g, '')
  text = text.replace(/\begin\{center\}/g, '').replace(/\end\{center\}/g, '')
  text = text.replace(/\\centering/g, '')
  // 转换 \img{key} 为 <img>
  text = text.replace(/\img[\{\[]\s*([^\}\]\s]+)\s*[\}\]]?/g, (_, key) => {
    const url = images[key] || ''
    return url ? `<img src="${url}" style="max-width:280px;display:block;margin:8px auto;">` : ''
  })
  // \item 在 MathJax 外才转换（选择题选项）
  text = text.replace(/\item\s*/g, '<br>&nbsp;&nbsp;• ')
  // 简单命令
  text = text.replace(/\\rule\{[^}]*\}\{[^}]*\}/g, '______')
  // 转义美元符还原（\$ → $），让 MathJax 处理行内公式
  text = text.replace(/\\\$/g, '$')
  return text
}

export async function generatePdfClient(
  questionIds: string[],
  title: string,
  includeAnswer: boolean,
  includeAnalysis: boolean
): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const html2canvas = (await import('html2canvas')).default

  // 1. 获取题目
  const questions: any[] = []
  const ids = [...new Set(questionIds)]
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200)
    const { data } = await supabase.from('math_questions').select('*').in('id', batch)
    if (data) questions.push(...data)
  }
  const typeOrder: Record<string, number> = { '单选': 1, '多选': 2, '填空': 3, '解答': 4 }
  questions.sort((a, b) => (typeOrder[a.type] || 99) - (typeOrder[b.type] || 99))

  // 2. 构建渲染容器：必须可见 MathJax 才会渲染；用白色遮罩盖住避免用户看到
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99998;'
  document.body.appendChild(overlay)
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:0;top:0;width:794px;background:#fff;padding:40px 48px;z-index:99999;font-family:"Noto Sans SC","SimSun","宋体",serif;font-size:14px;line-height:1.5;color:#000;'
  document.body.appendChild(container)

  // 标题（作为第一个块）
  const h = document.createElement('div')
  h.style.cssText = 'text-align:center;margin-bottom:24px;'
  h.innerHTML = `<h2 style="margin:0;font-size:22px;font-weight:700;">${title || '数学试卷'}</h2><p style="color:#333;margin:8px 0 0;font-size:13px;">（考试时间：120分钟&nbsp;&nbsp;满分：150分）</p><p style="margin:16px 0 0;font-size:13px;">姓名：____________&nbsp;&nbsp;&nbsp;得分：____________</p>`
  container.appendChild(h)

  // 题目块（答案版：题目在前）
  const blocks: HTMLDivElement[] = []
  blocks.push(h)
  questions.forEach((q, idx) => {
    const frontQ = toFrontendQuestion(q)
    const div = document.createElement('div')
    div.style.cssText = 'margin-bottom:20px;page-break-inside:avoid;text-align:left;'
    const qhtml = preprocessForPdf(frontQ.content, frontQ.images)
    const qType = frontQ.type || ''
    div.innerHTML = `<div style="margin-bottom:10px;"><span style="font-weight:700;">${idx + 1}.</span> <span style="color:#666;font-size:12px;">（${qType}）</span> ${qhtml}</div>`
    container.appendChild(div)
    blocks.push(div)
  })

  // 答案块：集中在后，强制分页
  if (includeAnswer || includeAnalysis) {
    const ansHeader = document.createElement('div')
    ansHeader.style.cssText = 'text-align:center;margin:40px 0 24px;page-break-before:always;'
    ansHeader.innerHTML = `<h2 style="margin:0;font-size:20px;font-weight:700;">参考答案</h2>`
    container.appendChild(ansHeader)
    blocks.push(ansHeader)
    questions.forEach((q, idx) => {
      const frontQ = toFrontendQuestion(q)
      const answer = frontQ.answer || ''
      const analysis = frontQ.analysis || ''
      if (!answer && !analysis) return
      const div = document.createElement('div')
      div.style.cssText = 'margin-bottom:18px;page-break-inside:avoid;text-align:left;'
      let html = `<div style="margin-bottom:8px;font-weight:700;font-size:15px;">第 ${idx + 1} 题</div>`
      if (answer) html += `<div style="margin:6px 0;"><span style="color:#2e7d32;font-weight:700;">答案：</span>${preprocessForPdf(answer, frontQ.images)}</div>`
      if (analysis) html += `<div style="margin-top:10px;padding-left:1em;border-left:3px solid #ddd;"><span style="font-weight:700;">解析：</span>${preprocessForPdf(analysis, frontQ.images)}</div>`
      div.innerHTML = html
      container.appendChild(div)
      blocks.push(div)
    })
  }

  // MathJax 输出样式：显示公式独立成行居中，行内公式垂直对齐
  const style = document.createElement('style')
  style.textContent = `
    mjx-container[display="true"] { display:block !important; text-align:center; margin:10px 0 !important; }
    mjx-container { font-size:1.02em; }
    table { max-width:100%; }
  `
  container.appendChild(style)

  // 3. 等待 MathJax 渲染（先确保 MathJax 已加载）
  try {
    if (window.MathJax?.typesetPromise) {
      await window.MathJax.typesetPromise([container])
    } else {
      // MathJax 未加载完成，等待
      for (let i = 0; i < 50 && !window.MathJax?.typesetPromise; i++) {
        await new Promise(r => setTimeout(r, 200))
      }
      if (window.MathJax?.typesetPromise) {
        await window.MathJax.typesetPromise([container])
      }
    }
    // 清理未渲染的 $ 残留
    container.querySelectorAll('div, p, span, td').forEach(el => {
      if (el.children.length === 0 && el.textContent?.includes('$')) {
        el.textContent = el.textContent.replace(/\$/g, '')
      }
    })
  } catch (e) { console.error('MathJax typeset:', e) }

  // 4. html2canvas 逐块截图 → jsPDF
  const pdf = new jsPDF('p', 'mm', 'a4')
  const pageW = 210, pageH = 297, margin = 10
  let y = margin

  for (const block of blocks) {
    const canvas = await html2canvas(block, { scale: 2, backgroundColor: '#ffffff' })
    const imgW = pageW - margin * 2
    const imgH = (canvas.height * imgW) / canvas.width
    // 强制分页：答案区标记（page-break-before:always）
    const forceBreak = block.style.pageBreakBefore === 'always'
    if (forceBreak || y + imgH > pageH - margin) {
      pdf.addPage()
      y = margin
    }
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', margin, y, imgW, imgH)
    y += imgH + 5
  }

  container.remove()
  overlay.remove()
  return pdf.output('blob')
}
