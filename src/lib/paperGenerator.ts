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

// 简化预处理：清理 LaTeX 环境，转换图片引用，保留数学定界符
function preprocessForPdf(latex: string, images: Record<string, string>): string {
  if (!latex) return ''
  let text = latex
  // 清理容器环境
  text = text.replace(/\begin\{minipage\}(\[[^\]]*\])?\{[^}]*\}/g, '')
  text = text.replace(/\end\{minipage\}/g, '')
  text = text.replace(/\begin\{center\}/g, '').replace(/\end\{center\}/g, '')
  text = text.replace(/\begin\{enumerate\}/g, '').replace(/\end\{enumerate\}/g, '')
  text = text.replace(/\begin\{itemize\}/g, '').replace(/\end\{itemize\}/g, '')
  text = text.replace(/\begin\{tabular\}[\s\S]*?\end\{tabular\}/g, (m) => m.replace(/\hline/g, '').replace(/\\/g, ' | ').replace(/&/g, ' | '))
  // 转换 \img{key} 为 <img>
  text = text.replace(/\img[\{\[]\s*([^\}\]\s]+)\s*[\}\]]?/g, (_, key) => {
    const url = images[key] || ''
    return url ? `<img src="${url}" style="max-width:280px;display:block;margin:8px auto;">` : ''
  })
  // 转换 \item 为换行
  text = text.replace(/\item\s*/g, '<br>• ')
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

  // 2. 构建隐藏渲染容器
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-9999px;top:0;width:794px;background:#fff;padding:40px;z-index:-1;'
  document.body.appendChild(container)

  // 标题
  const h = document.createElement('div')
  h.style.cssText = 'text-align:center;margin-bottom:20px;'
  h.innerHTML = `<h2 style="margin:0;">${title || '数学试卷'}</h2><p style="color:#666;margin:4px 0;">（考试时间：120分钟 满分：150分）</p>`
  container.appendChild(h)

  // 题目 + 答案块
  const blocks: HTMLDivElement[] = []
  questions.forEach((q, idx) => {
    const frontQ = toFrontendQuestion(q)
    const div = document.createElement('div')
    div.style.cssText = 'margin-bottom:24px;page-break-inside:avoid;'
    const qhtml = preprocessForPdf(frontQ.content, frontQ.images)
    const answer = frontQ.answer || ''
    const analysis = frontQ.analysis || ''
    div.innerHTML = `<div style="margin-bottom:8px;"><b>${idx + 1}.</b> ${qhtml}</div>`
    if (includeAnswer && answer) div.innerHTML += `<div style="color:#2e7d32;"><b>答案：</b>${answer}</div>`
    if (includeAnalysis && analysis) div.innerHTML += `<div style="color:#555;margin-top:4px;"><b>解析：</b>${analysis}</div>`
    container.appendChild(div)
    blocks.push(div)
  })

  // 3. 等待 MathJax 渲染
  try {
    if (window.MathJax?.typesetPromise) {
      await window.MathJax.typesetPromise([container])
    }
  } catch (e) { console.error('MathJax typeset:', e) }

  // 4. html2canvas 逐块截图 → jsPDF
  const pdf = new jsPDF('p', 'mm', 'a4')
  const pageW = 210, pageH = 297, margin = 10
  let y = margin
  const titleH = 25 // 标题占位
  y += titleH

  for (const block of blocks) {
    const canvas = await html2canvas(block, { scale: 2, backgroundColor: '#ffffff' })
    const imgW = pageW - margin * 2
    const imgH = (canvas.height * imgW) / canvas.width
    if (y + imgH > pageH - margin) {
      pdf.addPage()
      y = margin
    }
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', margin, y, imgW, imgH)
    y += imgH + 5
  }

  container.remove()
  return pdf.output('blob')
}
