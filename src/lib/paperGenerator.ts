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
