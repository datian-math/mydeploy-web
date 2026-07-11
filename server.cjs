const express = require('express');
require('dotenv').config();
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const sharp = require('sharp');
let Resvg = null;
try { Resvg = require('@resvg/resvg-js').Resvg; } catch (e) { /* 可选 */ }
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

// Supabase 客户端（服务器端直读数据库）
const supabaseUrl = process.env.SUPABASE_URL || 'https://cabuhfcsepwumrjnjdas.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_9LGzmTqbss5AOAH1c04wZg_HdVgfd7D';
const supabase = createClient(supabaseUrl, supabaseKey);
const supabaseEmail = process.env.SUPABASE_EMAIL || '';
const supabasePassword = process.env.SUPABASE_PASSWORD || '';
let supabaseReady = false;

// 启动时登录 Supabase（确保通过 RLS）
(async () => {
  try {
    if (supabaseEmail && supabasePassword) {
      const { error } = await supabase.auth.signInWithPassword({ email: supabaseEmail, password: supabasePassword });
      if (error) {
        console.warn('Supabase 登录失败（anon key 模式）:', error.message);
      } else {
        console.log('Supabase 已登录');
      }
    }
    supabaseReady = true;
  } catch (e) {
    console.warn('Supabase 初始化失败:', e.message);
    supabaseReady = true; // 降级模式
  }
})();

/**
 * 修复截断/不平衡的 LaTeX 文本（数据损坏防御）
 * 多层策略，逐层修复
 */
function sanitizeAnswer(text) {
  if (!text || typeof text !== 'string') return text;

  // ★ 步骤 0：修复常见 LLM 输出的 LaTeX 错误 ★
  // \p 孤立命令 → \pi（LLM 经常截断 \pi 变成 \p）
  text = text.replace(/(?<![a-zA-Z])\\p(?![a-zA-Z])/g, '\\pi');

  // ★ 策略1：检测末尾截断的 LaTeX 命令（含开启括号但无参数） ★
  // 匹配: \dfrac{ 或 \cos\!\left( 或 \sqrt{ 等（命令后有 { 或 ( 但无完整内容）
  const truncatedOpenCmd = /\\(?:d?frac|sqrt|sin|cos|tan|csc|sec|cot|log|ln|lim|max|min|sup|inf|gcd|lcm|begin|textbf|textit|mathbb|mathcal|mathbf|bar|hat|dot|ddot|vec|overrightarrow|overleftarrow|widehat|widetilde|left|right|big|Big|bigg|Bigg)(?:\s*\\!)?\s*(?:\\([^)]*\\)\s*)?(?:\[[^\]]*\]\s*)?\{\s*$/;
  if (truncatedOpenCmd.test(text)) {
    return truncateToLastCompleteSentence(text);
  }

  // ★ 策略2：检测末尾仅命令名（无任何参数） ★
  const truncatedCmd = /\\(?:d?frac|sqrt|sin|cos|tan|left|right|log|ln|begin|textbf|alpha|beta|pi|in|cdot|times|pm|mp|arcsin|arccos|arctan|sinh|cosh|tanh|csc|sec|cot)$/;
  if (truncatedCmd.test(text)) {
    return truncateToLastCompleteSentence(text);
  }

  // ★ 策略3：检测悬空的 $（奇数个 $，排除 $$ 块） ★
  let dollarCount = 0;
  let inDisplay = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i+1] === '$') { inDisplay = !inDisplay; i++; continue; }
    if (text[i] === '$' && !inDisplay) dollarCount++;
  }
  if (dollarCount % 2 !== 0) {
    // 尝试在末尾补齐 $
    // 先看看最后一段：如果以 $\therefore 等开头且无闭合，回退
    const lastDollar = text.lastIndexOf('$');
    if (lastDollar > text.length - 10) {
      // 最后一个 $ 就在末尾附近，直接去掉末尾未闭合段
      return truncateToLastCompleteSentence(text);
    }
    // 否则尝试补 $
    return text + '$';
  }

  // ★ 策略4：括号平衡检测与修复 ★
  let depth = 0;
  for (const c of text) {
    if (c === '{') depth++;
    if (c === '}') depth--;
  }
  if (depth === 0) return text;
  if (depth > 0) {
    return text + '}'.repeat(depth);
  }
  // 多余闭合括号 → 从末尾回溯删除
  let result = text;
  for (let i = 0; i < -depth; i++) {
    const lastOpen = result.lastIndexOf('{');
    if (lastOpen > 0) {
      result = result.substring(0, lastOpen);
    } else {
      result = result.replace(/}([^}]*)$/, '$1');
    }
  }
  return result;
}

/** 回退到最后一个完整句子 */
function truncateToLastCompleteSentence(text) {
  const cutPos = Math.max(
    text.lastIndexOf('。'),
    text.lastIndexOf('$\n'),
    text.lastIndexOf('；'),
    text.lastIndexOf('故选'),
    text.lastIndexOf('答案为')
  );
  if (cutPos > 20) {
    // 确保不留在未闭合的 $ 中
    const result = text.substring(0, cutPos + 1);
    let dCount = 0, inDD = false;
    for (let i = 0; i < result.length; i++) {
      if (result[i] === '$' && result[i+1] === '$') { inDD = !inDD; i++; continue; }
      if (result[i] === '$' && !inDD) dCount++;
    }
    if (dCount % 2 !== 0) return result + '$';
    return result;
  }
  return '';
}

/** 运行 xelatex 并捕获完整输出 */
async function runXelatex(xelatexPath, args, cwd) {
  return new Promise((resolve) => {
    const child = execFile(xelatexPath, args, { cwd }, (error, stdout, stderr) => {
      const output = (stdout || '') + '\n' + (stderr || '');
      if (error) {
        resolve(output + '\n[EXIT_CODE:' + error.code + ']');
      } else {
        resolve(output);
      }
    });
  });
}

const app = express();
const PORT = 3001;
const DATA_DIR = path.join(__dirname, 'data');
const IMAGES_DIR = path.join(__dirname, 'uploads/images');
const AUTO_SAVE_DIR = path.join(__dirname, 'data', 'auto-save');

// 辅助：递归搜索文件
function findFileRecursive(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) return fullPath;
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, filename);
      if (found) return found;
    }
  }
  return null;
}

// 确保自动保存目录存在
if (!fs.existsSync(AUTO_SAVE_DIR)) {
  try { fs.mkdirSync(AUTO_SAVE_DIR, { recursive: true }); console.log('已创建自动保存目录:', AUTO_SAVE_DIR); }
  catch (e) { console.error('无法创建自动保存目录:', e.message); }
}

const PAPERS_DIR = path.join(DATA_DIR, 'papers');
const PAPERS_JSON = path.join(DATA_DIR, 'papers.json');

// 确保 papers 目录和元数据文件存在
if (!fs.existsSync(PAPERS_DIR)) {
  fs.mkdirSync(PAPERS_DIR, { recursive: true });
}
if (!fs.existsSync(PAPERS_JSON)) {
  fs.writeFileSync(PAPERS_JSON, '[]', 'utf8');
}

// 读取试卷列表（兼容旧格式）
function readPapers() {
  try {
    const data = JSON.parse(fs.readFileSync(PAPERS_JSON, 'utf8'));
    // 规范化旧格式数据
    return data.map(p => ({
      ...p,
      filename: p.filename || p.fileName || '未知文件.pdf',
      size: p.size || 0,
      questionCount: p.questionCount || 0,
      includeAnswer: !!p.includeAnswer,
      includeAnalysis: !!p.includeAnalysis
    }));
  } catch (e) {
    return [];
  }
}

// 保存试卷列表
function writePapers(papers) {
  fs.writeFileSync(PAPERS_JSON, JSON.stringify(papers, null, 2), 'utf8');
}

// 自动保存文件到 data/auto-save（不阻塞主流程）
function autoSaveFile(buffer, filename) {
  try {
    if (!fs.existsSync(AUTO_SAVE_DIR)) return;
    // 文件名中的中文需要保持，直接用原文件名
    let destPath = path.join(AUTO_SAVE_DIR, filename);
    // 如果已存在，加时间戳避免覆盖
    if (fs.existsSync(destPath)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      const ts = new Date().toISOString().replace(/T/, '_').replace(/[:.]/g, '-').slice(0, 19);
      destPath = path.join(AUTO_SAVE_DIR, `${base}_${ts}${ext}`);
    }
    fs.writeFileSync(destPath, buffer);
    console.log('已自动保存到 auto-save:', path.basename(destPath));
  } catch (e) {
    console.error('自动保存失败（不影响下载）:', e.message);
  }
}

// 修复 LaTeX 文本中的括号不平衡（坑2：防止 Extra }, or forgotten \endgroup）
// 逐字符扫描，正确处理数学模式中的 {}
function fixBraceBalance(text) {
  let result = '';
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // 检测数学模式入口（跳过数学模式内容中的 {}）
    if (c === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === '(' || next === '[') {
        const endMarker = next === '(' ? '\\)' : '\\]';
        const endIdx = text.indexOf(endMarker, i + 2);
        if (endIdx !== -1) {
          result += text.slice(i, endIdx + endMarker.length);
          i = endIdx + endMarker.length;
          continue;
        }
      }
    }
    // 行内数学模式 $...$（简单处理：跳到下一个 $）
    if (c === '$') {
      const nextDollar = text.indexOf('$', i + 1);
      if (nextDollar !== -1) {
        result += text.slice(i, nextDollar + 1);
        i = nextDollar + 1;
        continue;
      }
    }
    // 非数学模式下跟踪大括号深度
    if (c === '{') {
      depth++;
      result += c;
    } else if (c === '}') {
      if (depth > 0) {
        depth--;
        result += c;
      }
      // depth === 0 时丢弃多余的 }
    } else {
      result += c;
    }
    i++;
  }
  // 末尾补全缺失的 }
  while (depth > 0) {
    result += '}';
    depth--;
  }
  return result;
}

// 确保目录存在
[DATA_DIR, IMAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// 数据文件路径
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const EXAM_QUESTIONS_FILE = path.join(DATA_DIR, 'exam_questions.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
const BASKET_FILE = path.join(DATA_DIR, 'basket.json');

// 初始化数据文件
function initDataFile(file, defaultData = []) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultData, null, 2), 'utf8');
  }
}
initDataFile(QUESTIONS_FILE);
initDataFile(BASKET_FILE);

// 初始化知识点分类（如果不存在）
const defaultCategories = [
  { id: 'cat-1', name: '集合与常用逻辑用语', children: [
    { id: 'cat-1-1', name: '集合' },
    { id: 'cat-1-2', name: '常用逻辑用语' }
  ]},
  { id: 'cat-2', name: '等式与不等式', children: [
    { id: 'cat-2-1', name: '等式' },
    { id: 'cat-2-2', name: '不等关系与一元二次不等式' },
    { id: 'cat-2-3', name: '二元一次不等式（组）与简单的线性规划' },
    { id: 'cat-2-4', name: '基本不等式' }
  ]},
  { id: 'cat-3', name: '函数', children: [
    { id: 'cat-3-1', name: '函数的概念与性质' },
    { id: 'cat-3-2', name: '基本初等函数 I' },
    { id: 'cat-3-3', name: '函数的应用' }
  ]},
  { id: 'cat-4', name: '导数及其应用', children: [
    { id: 'cat-4-1', name: '变化率与导数' },
    { id: 'cat-4-2', name: '导数的运算' },
    { id: 'cat-4-3', name: '导数在函数问题中的应用' },
    { id: 'cat-4-4', name: '导数综合问题' },
    { id: 'cat-4-5', name: '导数的实际应用' },
    { id: 'cat-4-6', name: '定积分' },
    { id: 'cat-4-7', name: '极限问题' }
  ]},
  { id: 'cat-5', name: '三角函数', children: [
    { id: 'cat-5-1', name: '任意角和弧度制' },
    { id: 'cat-5-2', name: '三角函数线' },
    { id: 'cat-5-3', name: '诱导公式' },
    { id: 'cat-5-4', name: '三角函数的图像与性质' },
    { id: 'cat-5-5', name: '三角恒等变换' },
    { id: 'cat-5-6', name: '解三角形' }
  ]},
  { id: 'cat-6', name: '平面向量', children: [
    { id: 'cat-6-1', name: '向量的概念与线性运算' },
    { id: 'cat-6-2', name: '平面向量基本定理' },
    { id: 'cat-6-3', name: '向量的数量积' },
    { id: 'cat-6-4', name: '向量的应用' }
  ]},
  { id: 'cat-7', name: '复数', children: [
    { id: 'cat-7-1', name: '复数的概念' },
    { id: 'cat-7-2', name: '复数的运算' }
  ]},
  { id: 'cat-8', name: '数列', children: [
    { id: 'cat-8-1', name: '数列的概念' },
    { id: 'cat-8-2', name: '等差数列' },
    { id: 'cat-8-3', name: '等比数列' },
    { id: 'cat-8-4', name: '数列求和' },
    { id: 'cat-8-5', name: '数列综合' }
  ]},
  { id: 'cat-9', name: '空间向量与立体几何', children: [
    { id: 'cat-9-1', name: '空间向量及其运算' },
    { id: 'cat-9-2', name: '空间向量的应用' },
    { id: 'cat-9-3', name: '空间几何体' },
    { id: 'cat-9-4', name: '点线面位置关系' }
  ]},
  { id: 'cat-10', name: '平面解析几何', children: [
    { id: 'cat-10-1', name: '直线与方程' },
    { id: 'cat-10-2', name: '圆与方程' },
    { id: 'cat-10-3', name: '椭圆' },
    { id: 'cat-10-4', name: '双曲线' },
    { id: 'cat-10-5', name: '抛物线' },
    { id: 'cat-10-6', name: '圆锥曲线综合' }
  ]},
  { id: 'cat-11', name: '计数原理与概率统计', children: [
    { id: 'cat-11-1', name: '排列组合' },
    { id: 'cat-11-2', name: '二项式定理' },
    { id: 'cat-11-3', name: '随机事件与概率' },
    { id: 'cat-11-4', name: '古典概型与几何概型' },
    { id: 'cat-11-5', name: '统计' },
    { id: 'cat-11-6', name: '随机变量及其分布' }
  ]}
];
initDataFile(CATEGORIES_FILE, defaultCategories);

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads/images', express.static(IMAGES_DIR));
app.use('/api/exam-images', express.static(path.join(DATA_DIR, 'exam_images')));

// 图片上传配置
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMAGES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = 'img_' + Date.now() + ext;
    cb(null, uniqueName);
  }
});
const uploadImage = multer({ storage: imageStorage });

// 读取数据
function readData(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// 写入数据
function writeData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}


// ==================== 图片上传 API ====================
app.post('/api/upload-image', uploadImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file' });

  const normalizedExt = '.jpg';
  const normalizedFilename = path.basename(req.file.filename, path.extname(req.file.filename)) + normalizedExt;
  const normalizedPath = path.join(IMAGES_DIR, normalizedFilename);
  let inputPath = req.file.path;

  try {
    // ⚠️ 防御同路径覆盖：如果输入输出是同一文件，先复制到临时文件
    if (path.resolve(inputPath) === path.resolve(normalizedPath)) {
      const tmpPath = inputPath + '.tmp_' + Date.now();
      fs.copyFileSync(inputPath, tmpPath);
      inputPath = tmpPath;
    }

    // 归一化图片为 xelatex 兼容的标准 JPEG
    await sharp(inputPath)
      .jpeg({ quality: 92 })
      .toFile(normalizedPath);

    // 如果使用了临时文件，删除它
    if (inputPath !== req.file.path) {
      try { fs.unlinkSync(inputPath); } catch {}
    }

    // ⚠️ 校验1：文件大小不能太小（< 1KB 视为异常）
    const stat = fs.statSync(normalizedPath);
    if (stat.size < 1024) {
      console.warn('⚠ 归一化后图片太小 (' + stat.size + ' bytes)，视为异常');
      throw new Error('Normalized image too small');
    }

    // ⚠️ 校验2：检查是否全黑
    try {
      const { data } = await sharp(normalizedPath).raw().toBuffer({ resolveWithObject: true });
      let sum = 0;
      const sampleCount = Math.min(data.length, 10000);
      for (let i = 0; i < sampleCount; i++) sum += data[i];
      const avg = sum / sampleCount;
      if (avg < 5) {
        console.warn('⚠ 归一化后图片全黑 (avg=' + avg.toFixed(1) + ')，视为异常');
        throw new Error('Normalized image is black');
      }
    } catch (e) {
      if (e.message.includes('Normalized image')) throw e;
      // 无法读取像素数据，继续
    }

    // 删除原始文件（如果扩展名变了且还存在）
    if (req.file.path !== normalizedPath && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }

    const url = '/uploads/images/' + normalizedFilename;
    return res.json({ url, filename: normalizedFilename });
  } catch (err) {
    console.error('图片处理失败:', err.message);
    // 清理可能生成的损坏文件
    if (fs.existsSync(normalizedPath)) {
      try { fs.unlinkSync(normalizedPath); } catch {}
    }
    // 尝试返回原始文件（如果还存在且大小正常）
    if (fs.existsSync(req.file.path)) {
      const origStat = fs.statSync(req.file.path);
      if (origStat.size >= 1024) {
        const url = '/uploads/images/' + req.file.filename;
        return res.json({ url, filename: req.file.filename });
      }
    }
    // 原始文件也不可用，返回错误
    return res.status(500).json({ error: '图片处理失败：' + err.message });
  }
});

// ==================== 知识点分类 API ====================
app.get('/api/categories', (req, res) => {
  res.json(readData(CATEGORIES_FILE));
});

app.post('/api/categories', (req, res) => {
  const categories = readData(CATEGORIES_FILE);
  const newCategory = { id: 'cat-' + Date.now(), ...req.body, children: req.body.children || [] };
  categories.push(newCategory);
  writeData(CATEGORIES_FILE, categories);
  res.json(newCategory);
});

// ==================== 试题 API ====================
app.get('/api/questions', (req, res) => {
  let questions = readData(QUESTIONS_FILE);
  const { category, difficulty, type, grade, keyword, tag } = req.query;
  if (category) questions = questions.filter(q => q.categoryId === category || q.categoryPath?.includes(category));
  if (difficulty && difficulty !== 'all') questions = questions.filter(q => q.difficulty === difficulty);
  if (type && type !== 'all') questions = questions.filter(q => q.type === type);
  if (grade && grade !== 'all') questions = questions.filter(q => q.grade === grade);
  if (tag) questions = questions.filter(q => q.tags?.includes(tag));
  if (keyword) {
    const kw = keyword.toLowerCase();
    questions = questions.filter(q => q.content?.toLowerCase().includes(kw) || q.title?.toLowerCase().includes(kw) || q.tags?.some(t => t.toLowerCase().includes(kw)));
  }
  questions.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  res.json(questions);
});

app.get('/api/questions/:id', (req, res) => {
  const question = readData(QUESTIONS_FILE).find(q => q.id === req.params.id);
  question ? res.json(question) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/questions', (req, res) => {
  const questions = readData(QUESTIONS_FILE);
  const newQuestion = { id: 'q-' + Date.now(), ...req.body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  questions.push(newQuestion);
  writeData(QUESTIONS_FILE, questions);
  res.json(newQuestion);
});

app.put('/api/questions/:id', (req, res) => {
  let questions = readData(QUESTIONS_FILE);
  const index = questions.findIndex(q => q.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  questions[index] = { ...questions[index], ...req.body, updatedAt: new Date().toISOString() };
  writeData(QUESTIONS_FILE, questions);
  res.json(questions[index]);
});

app.delete('/api/questions/:id', (req, res) => {
  let questions = readData(QUESTIONS_FILE);
  const deleted = questions.find(q => q.id === req.params.id);
  questions = questions.filter(q => q.id !== req.params.id);
  writeData(QUESTIONS_FILE, questions);
  res.json({ success: true });
});

// ==================== 试卷篮 API ====================
app.get('/api/basket', (req, res) => res.json(readData(BASKET_FILE)));

app.post('/api/basket', (req, res) => {
  const basket = readData(BASKET_FILE);
  if (!basket.find(item => item.questionId === req.body.questionId)) {
    basket.push({ questionId: req.body.questionId, addedAt: new Date().toISOString() });
    writeData(BASKET_FILE, basket);
  }
  res.json({ success: true });
});

app.delete('/api/basket/:questionId', (req, res) => {
  let basket = readData(BASKET_FILE);
  basket = basket.filter(item => item.questionId !== req.params.questionId);
  writeData(BASKET_FILE, basket);
  res.json({ success: true });
});

app.delete('/api/basket', (req, res) => {
  writeData(BASKET_FILE, []);
  res.json({ success: true });
});

// 辅助函数：转换图片引用
function convertImages(content, images) {
  if (!content) return content;
  return content.replace(/\\img\{([^}]+)\}/g, (match, key) => {
    const imageUrl = images?.[key];
    if (imageUrl) {
      const filename = path.basename(imageUrl);
      return `\\includegraphics[width=0.6\\textwidth]{images/${filename}}`;
    }
    return `% [图片 ${key} 未找到]`;
  });
}

// ==================== 试卷生成 API（exam 文档类） ====================
// 辅助函数：判断题目排版格式
function getQuestionFormat(q) {
  const hasOptionsArray = q.options && q.options.length > 0;
  // 支持两种选项格式：\item 格式 和 A. B. C. D. 格式（含半角.和全角．）
  const hasItemOptions = q.content && /\\item\s*[^\\\n]/.test(q.content);
  const hasAbcdOptions = q.content && / [A-D][\.．]\s/.test(q.content);
  // 兜底：选项紧跟换行或（ ）结尾时也识别为选择题
  const hasAbcdOptionsNewline = q.content && /\n\s*[A-D][\.．]\s*\S/.test(q.content);
  const hasOptions = hasOptionsArray || hasItemOptions || hasAbcdOptions || hasAbcdOptionsNewline;
  if (q.type === '单选' && hasOptions) return 'single';
  if (q.type === '多选' && hasOptions) return 'multi';
  if (q.type === '填空') return 'fill';
  return 'solution';
}

// 辅助函数：检查题目是否包含图片（检测 \includegraphics 命令或 images 对象）
function hasImages(q) {
  if (q.images && Object.keys(q.images).length > 0) return true;
  if (q.content && /\\includegraphics/.test(q.content)) return true;
  return false;
}

// 辅助函数：估算选项纯文本长度（去掉 LaTeX 标记）
function estimateOptionLength(opt) {
  let s = opt;
  // 去掉注释
  s = s.replace(/%[*]*%]/g, '');
  s = s.replace(/%.*/g, '');
  // 把常见宽 LaTeX 结构替换成近似宽度
  s = s.replace(/\\frac\{[^}]*\}\{[^}]*\}/g, '宽分数');
  s = s.replace(/\\sqrt\{[^}]*\}/g, '√');
  s = s.replace(/\\left\./g, '');
  s = s.replace(/\\right\./g, '');
  s = s.replace(/\\left[\\([]/g, '(');
  s = s.replace(/\\right[\\\)\]]/g, ')');
  // 去掉所有 \xxx 命令（保留花括号内容）
  s = s.replace(/\\[a-zA-Z]+(\*?)([\\[].*?\\])?(\{[^}]*\})?/g, '');
  // 去掉花括号
  s = s.replace(/[{}]/g, '');
  // 去掉多余空格
  s = s.replace(/\s+/g, ' ');
  return s.trim().length;
}
// 辅助函数：决定选择题排版方式
// 返回 'onepar' | 'vertical'
// 注意：不用 multicols（列优先填充会打乱 A/B/C/D 顺序）
// oneparchoices 放不下时自动换行，天然形成 2×2 网格
function chooseChoiceLayout(options) {
  const lens = options.map(estimateOptionLength);
  const maxLen = Math.max(...lens);

  if (maxLen <= 22) return 'onepar';       // 短选项：oneparchoices，自动换行
  return 'vertical';                         // 长选项：竖排兜底
}

// 辅助函数：从内容中提取所有图片的 LaTeX
function extractImages(content) {
  let imagesLatex = '';
  if (!content) return imagesLatex;
  return content.replace(/\\includegraphics(\[[^\]]*\])?\{([^}]+)\}/g, (match, opts, path) => {
    imagesLatex += `\\includegraphics${opts || ''}{${path}}\n`;
    return '';
  });
}

// 辅助函数：获取题目的图片 LaTeX（从 images 对象）
function getQuestionImagesFromObject(q) {
  if (!q.images) return '';
  let imgLatex = '';
  Object.entries(q.images).forEach(([key, url]) => {
    const filename = path.basename(url);
    imgLatex += `\\includegraphics[width=0.9\\textwidth]{images/${filename}}\n`;
  });
  return imgLatex;
}

// 辅助函数：把十六进制颜色（#RRGGBB）转换成 xcolor 的 [HTML]{RRGGBB} 格式
function hexToXcolor(hex) {
  // ⚠️ 废弃：改用 generateColorDefs 在 preamble 中 \definecolor，tcb 中用颜色名引用
  if (!hex || hex === 'transparent') return null;
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  return m[1].toUpperCase();
}

// 为所有自定义样式生成唯一的颜色定义名
function generateColorDefs(styleMap, questions) {
  const defs = [];  // LaTeX \definecolor 命令列表
  const colorNames = {}; // hex -> LaTeX color name
  let colorIdx = 0;

  const registerColor = (hex) => {
    const code = hexToXcolor(hex);
    if (!code) return null;
    if (colorNames[code]) return colorNames[code];
    const name = 'cb' + (colorIdx++); // cb0, cb1, ...
    colorNames[code] = name;
    defs.push('\\definecolor{' + name + '}{HTML}{' + code + '}');
    return name;
  };

  // 遍历所有题目的样式，收集需要的颜色
  questions.forEach(q => {
    const style = styleMap[q.id] || {};
    if (style.hasBorder || (style.backgroundColor && style.backgroundColor !== 'transparent')) {
      registerColor(style.backgroundColor);
      registerColor(style.borderColor);
    }
  });

  return {
    definitions: defs.join('\n'),
    lookup: (hex) => {
      const code = hexToXcolor(hex);
      if (!code) return 'white';
      return colorNames[code] || 'white';
    }
  };
}

// ===== LaTeX 数学模式分隔符平衡器 =====
// 防止 "Missing $ inserted" / "\item invalid in math mode" 等编译错误
// 处理 $...$ 和 \(...\) 两种数学模式
function balanceMathDelimiters(text) {
  // 策略：逐字符扫描，追踪 $ 和 \( \) 的配对状态
  // 对不配对的情况自动补全闭合符号

  // 1) 平衡 \( 和 \)
  let openParen = 0;
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (text.substr(i, 2) === '\\(') {
      openParen++;
      result += '\\(';
      i++; // skip (
    } else if (text.substr(i, 2) === '\\)') {
      if (openParen > 0) {
        openParen--;
        result += '\\)';
        i++; // skip )
      } else {
        // 多余的闭合符，跳过（或转为普通文本）
        // 这里选择跳过避免嵌套错误
        i++;
      }
    } else {
      result += text[i];
    }
  }
  // 补齐未关闭的 \(
  while (openParen-- > 0) {
    result += '\\)';
  }

  // 2) 平衡 $ （排除已处理的 \( \) 内部——简单方案：直接计数）
  // 注意：$$ 不在普通题目中使用，只处理单 $
  let dollarCount = 0;
  let balanced = '';
  for (let i = 0; i < result.length; i++) {
    if (result[i] === '$' && (i === 0 || result[i-1] !== '$')) {
      // 单个 $ 开关
      if (i + 1 < result.length && result[i+1] === '$') {
        // $$ 配对，跳过
        balanced += '$$';
        i++;
      } else {
        dollarCount++;
        balanced += '$';
      }
    } else if (result[i] === '$' && i > 0 && result[i-1] !== '$') {
      dollarCount++;
      balanced += '$';
    } else {
      balanced += result[i];
    }
  }
  // 如果 $ 数量是奇数，补一个
  if (dollarCount % 2 !== 0) {
    balanced += '$';
  }

  return balanced;
}

// ===== 选项数学模式自动包装器 =====
// 选择题选项如 "2\sqrt{5}" 需变成 "$2\sqrt{5}$" 才能让 LaTeX 编译通过
function wrapChoiceMath(opt) {
  if (!opt) return opt;
  // 已包裹（开头 $ 结尾 $ 或 \(...\)）→ 不动
  if (/^\s*\$.*\$\s*$/.test(opt)) return opt;
  if (/^\s*\\\(.*\\\)\s*$/.test(opt)) return opt;
  // 含数学命令或上下标（^\_）但未包裹 → 自动加 $
  if (/\\[a-zA-Z]+|[\^_]/.test(opt)) {
    return '$' + opt + '$';
  }
  return opt;
}

// 辅助函数：将题目格式化为 exam 文档类格式（符合 math-exam-generator 规范）
function formatQuestionForExam(q, includeAnswer, includeAnalysis) {
  let body = q.content || '';
  // 清理不支持的宏包命令（physics 包的 \paren 等）
  body = body.replace(/\\paren\{\}/g, '').replace(/\\paren\{([^}]*)\}/g, '$1');
  body = body.replace(/\\qq\{\}/g, '').replace(/\\qq\{([^}]*)\}/g, '$1');

  // ===== 步骤 0：修复常见 LLM 输出的 LaTeX 错误 =====
  // 1) \p 孤立命令 → \pi（LLM 经常截断 \pi）
  body = body.replace(/(?<![a-zA-Z])\\p(?![a-zA-Z])/g, '\\pi');
  // 2) 平衡 $ 数学模式分隔符（防止 "Missing $ inserted" / "\item invalid in math mode"）
  body = balanceMathDelimiters(body);
  // 3) 清理连续的 \\ 为单个换行（避免在非表格环境中的 \\ 引起问题）
  body = body.replace(/\\\\+/g, '\\\\\n');  // 最多保留一个 \\ + 换行

  const answer = sanitizeAnswer(q.answer || q.answerContent || '');
  const isChoice = q.type === '单选' || q.type === '多选';

  // ===== 步骤 0：转换 <img> 标签为 \includegraphics（高考题图片兼容）=====
  body = body.replace(/<img\s+[^>]*src\s*=\s*["']\/api\/exam-images\/([^"']+)["'][^>]*\/?>/gi, (match, filename) => {
    // SVG 转 JPG 后缀，XeLaTeX 不支持 SVG
    const texFilename = filename.replace(/\.svg$/i, '.jpg');
    return `\\includegraphics[width=0.5\\linewidth]{images/${texFilename}}`;
  });

  // ===== 步骤 1：转换 \img{key} 为 \includegraphics =====
  // 选择题: 0.5\linewidth；解答题: 0.35\linewidth；填空题: 0.25\linewidth
  body = body.replace(/\\img\{([^}]+)\}/g, (match, key) => {
    const imageUrl = q.images?.[key];
    if (imageUrl) {
      const filename = path.basename(imageUrl);
      let width;
      if (isChoice) {
        width = '0.5\\linewidth';
      } else if (q.type === '解答') {
        width = '0.35\\linewidth';
      } else {
        width = '0.25\\linewidth';
      }
      return `\\includegraphics[width=${width}]{images/${filename}}`;
    }
    return `% [图片 ${key} 未找到]`;
  });

  // ===== 步骤 2：从 body 中提取 \includegraphics =====
  // 选择题：提取到 imagesLatex 用于 minipage 左图排版
  // 非选择题：保留 inline（左对齐显示）
  let imagesLatex = '';
  if (isChoice) {
    body = body.replace(/\\includegraphics(\[[^\]]*\])?\{([^}]+)\}/g, (match, opts, imgPath) => {
      imagesLatex += `\\includegraphics${opts || ''}{${imgPath}}\n`;
      return '';
    });
  }
  const hasImg = imagesLatex.length > 0;

  // ===== 步骤 3：处理选择题的选项 =====
  // 目标：body=纯题干(不含选项), options=纯内容数组(不含A.B.C.D.前缀)
  let options = q.options || [];
  if (isChoice) {
    // --- 当 q.options 为空时，从 body 提取 ---
    if (options.length === 0) {
      // 方式A：用 \item 分割（LaTeX 格式）
      const parts = body.split(/\\item\s*/);
      if (parts.length > 1) {
        options = parts.slice(1).map(p => {
          p = p.trim();
          p = p.replace(/\\end\{choices\}\s*/g, '');
          p = p.replace(/\\end\{oneparchoices\}\s*/g, '');
          return p;
        }).filter(p => p);
        body = parts[0];
      }
      // 清理 body 中残留的 choices 环境标签
      body = body.replace(/\\begin\{choices\}\s*/g, '');
      body = body.replace(/\\end\{choices\}\s*/g, '');
      body = body.replace(/\\begin\{oneparchoices\}\s*/g, '');
      body = body.replace(/\\end\{oneparchoices\}\s*/g, '');

      // 方式B：A./A． 格式（支持半角.全角．和换行分隔）
      if (options.length === 0) {
        const abcdMatch = body.match(/(?:^|\n|\s|[（）()])([A-D])[\.．]/);
        if (abcdMatch && abcdMatch.index !== undefined) {
          const letterPos = abcdMatch.index + (abcdMatch[0].length - 2);
          if (letterPos >= 2) {
            const stemPart = body.substring(0, letterPos).trim();
            const optsPart = body.substring(letterPos);
            // 全局正则提取每个选项内容（不含前缀）
            const optRe = /([A-D])[\.．]\s*(\S[\s\S]*?)(?=\s*(?:[A-D])[\.．]|$)/g;
            let m;
            const extracted = [];
            while ((m = optRe.exec(optsPart)) !== null) {
              extracted.push(m[2].trim());
            }
            // fallback：全局正则结果不足时用 split
            if (extracted.length < 2) {
              const rawOpts = optsPart.split(/(?:\n|\s)+(?=[A-D][\.．])/);
              for (let r = 0; r < rawOpts.length; r++) {
                const ro = rawOpts[r].trim();
                if (ro && /^[A-D][\.．]/.test(ro)) {
                  extracted.push(ro.replace(/^[A-D][\.．]\s*/, ''));
                }
              }
            }
            if (extracted.length >= 2) { options = extracted; body = stemPart; }
          }
        }
      }
    }

    // ★ 无论 options 来源如何，始终清理 body 中残留的 A.-D. 文本 ★
    body = body.replace(/(?:^|\n)\s*[A-D][\.．]\s*.*$/gm, '');
    body = body.replace(/\s+[A-D][\.．]\s*\S[\S]*$/g, '');
  }

  // 清理选项文本中的 LaTeX 残留标签 + 确保无前缀
  options = options.map(opt => {
    opt = opt.replace(/\\begin\{choices\}\s*/g, '');
    opt = opt.replace(/\\end\{choices\}\s*/g, '');
    opt = opt.replace(/\\begin\{oneparchoices\}\s*/g, '');
    opt = opt.replace(/\\end\{oneparchoices\}\s*/g, '');
    // 清理 minipage 片断（\begin{minipage} 和 \end{minipage} 残留）
    opt = opt.replace(/\\begin\{minipage\}(\{[^}]*\})?/g, '');
    opt = opt.replace(/\\end\{minipage\}/g, '');
    // ★ 兜底：确保无 A./B./C./D. 前缀 ★
    opt = opt.replace(/^[A-D][\.．]\s*/, '');
    return opt.trim();
  });
  // ★ 选项数学模式自动包装：含 \sqrt, \frac, \pi 等但未包 $...$ 的自动加上
  options = options.map(wrapChoiceMath);

  // 去掉题干末尾已有的 （ ）（避免重复添加）
  body = body.replace(/[（(]\s*\\quad\s*[）)][\s]*$/g, '');
  body = body.replace(/[（(]\s*[）)][\s]*$/g, '');
  if (!isChoice) {
    let itemIndex = 1;
    body = body.replace(/\\item\s*/g, () => {
      return `(${itemIndex++}) `;
    });
  } else {
    // 选择题：移除剩余的 \item（兜底）
    body = body.replace(/\\item\s*/g, '');
  }

  let latex = '';
  const format = getQuestionFormat(q);

  if (format === 'single') {
    // 单选题
    if (hasImg) {
      // 有图片：minipage 双栏排版（左选项右图片）
      latex += body.trim() + '\\\\\n';
      latex += '\\vspace{-0.3em}\n';
      latex += '\\begin{minipage}{0.48\\linewidth}\n';
      latex += '\\vspace{0.5em}\n';
      latex += '\\begin{choices}\n';
      options.forEach(opt => { latex += '\\choice ' + opt + '\n'; });
      latex += '\\end{choices}\n';
      latex += '\\end{minipage}\\hfill\n';
      latex += '\\begin{minipage}{0.48\\linewidth}\n';
      latex += '{\\centering ' + imagesLatex + '\\par}\n';
      latex += '\\end{minipage}\n';
    } else {
      // 无图片：按选项长度动态选择排法
      latex += body.trim() + '（\\quad ）\\par\n';
      const layout = chooseChoiceLayout(options);
      if (layout === 'onepar') {
        // 短选项：oneparchoices，放不下自动换行为 2×2
        latex += '\\begin{oneparchoices}\n';
        options.forEach(opt => { latex += '\\choice ' + opt + '\n'; });
        latex += '\\end{oneparchoices}\n';
      } else {
        // 长选项：竖排
        latex += '\\begin{choices}\n';
        options.forEach(opt => { latex += '\\choice ' + opt + '\n'; });
        latex += '\\end{choices}\n';
      }
    }
  } else if (format === 'multi') {
    // 多选题
    if (hasImg) {
      // 有图片：minipage 双栏排版（左选项右图片）
      latex += body.trim() + '\\\\\n';
      latex += '\\vspace{-0.3em}\n';
      latex += '\\begin{minipage}{0.48\\linewidth}\n';
      latex += '\\vspace{0.5em}\n';
      latex += '\\begin{choices}\n';
      options.forEach(opt => { latex += '\\choice ' + opt + '\n'; });
      latex += '\\end{choices}\n';
      latex += '\\end{minipage}\\hfill\n';
      latex += '\\begin{minipage}{0.48\\linewidth}\n';
      latex += '{\\centering ' + imagesLatex + '\\par}\n';
      latex += '\\end{minipage}\n';
    } else {
      // 无图片：按选项长度动态选择排法
      latex += body.trim() + '\\par\n';
      const layout = chooseChoiceLayout(options);
      if (layout === 'onepar') {
        // 短选项：oneparchoices，放不下自动换行为 2×2
        latex += '\\begin{oneparchoices}\n';
        options.forEach(opt => { latex += '\\choice ' + opt + '\n'; });
        latex += '\\end{oneparchoices}\n';
      } else {
        // 长选项：竖排
        latex += '\\begin{choices}\n';
        options.forEach(opt => { latex += '\\choice ' + opt + '\n'; });
        latex += '\\end{choices}\n';
      }
    }
  } else if (format === 'fill') {
    // 填空题：处理下划线和 \quad；图片强制换行后显示（左对齐，0.25\linewidth）
    body = body.replace(/_{4,}/g, '\\fillin[' + answer + ']');
    body = body.replace(/（\\quad\s*\)/g, '\\fillin[' + answer + ']');
    // 图片换行：在 \includegraphics 前插入 \par（确保另起一段）
    body = body.replace(/(\\includegraphics)/g, '\\par$1');
    latex += body.trim() + '\n';
  } else {
    // 解答题：图片强制换行后显示（左对齐，0.25\linewidth）
    // 在 \includegraphics 前插入 \par（确保另起一段）
    body = body.replace(/(\\includegraphics)/g, '\\par$1');
    latex += body.trim() + '\n';
  }

  // 教师版：答案与解析
  if (includeAnswer) {
    latex += '\\begin{solution}\n';
    if (answer) {
      // ALSO balance math in answer text too, and fix \p
      let answerText = answer.replace(/(?<![a-zA-Z])\\p(?![a-zA-Z])/g, '\\pi');
      answerText = balanceMathDelimiters(answerText);
      latex += '\\textbf{答案：}' + answerText + '\n';
    }
    if (includeAnalysis && q.analysis) {
      let analysis = sanitizeAnswer(q.analysis);
      // ★ 也修复 \p 和分析中的数学模式平衡
      analysis = analysis.replace(/(?<![a-zA-Z])\\p(?![a-zA-Z])/g, '\\pi');
      analysis = balanceMathDelimiters(analysis);
      // 修复 \img{key} 引用 → \includegraphics
      analysis = analysis.replace(/\\img\{([^}]+)\}/g, (_, key) => {
        if (q.images && q.images[key]) {
          const filename = require('path').basename(q.images[key]);
          return `\\includegraphics[width=0.4\\linewidth]{images/${filename}}`;
        }
        return '';
      });
      // 修复已有 \includegraphics 路径（确保只用文件名）
      analysis = analysis.replace(/\\includegraphics(\[[^\]]*\])?\{([^}]+)\}/g, (match, opts, imgPath) => {
        const filename = require('path').basename(imgPath);
        return `\\includegraphics${opts || '[width=0.4\\linewidth]'}{images/${filename}}`;
      });
      // 修复解析中多余的 }（坑2：导致 Extra }, or forgotten \endgroup）
      // 使用逐字符扫描，正确处理数学模式中的 {}
      analysis = fixBraceBalance(analysis);
      latex += analysis + '\n';
    }
    latex += '\\end{solution}\n';
  }

  return latex;
}

// 生成试卷（exam 文档类）
// format: 'zip'（默认）返回 LaTeX 源码包；'pdf' 返回编译后的 PDF
app.post('/api/generate-paper', async (req, res) => {
  const { title, questionIds, items = [], includeAnswer = false, includeAnalysis = false, format = 'zip', paperSize = 'b4' } = req.body;

  // 从 Supabase 查询题目
  let allQuestions = [];
  if (supabaseReady && questionIds?.length > 0) {
    const ids = [...new Set(questionIds)];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const { data } = await supabase.from('math_questions').select('*').in('id', batch);
      if (data) allQuestions = allQuestions.concat(data);
    }
    // 转换为服务器代码期待的格式（兼容本地 JSON 字段名）
    allQuestions = allQuestions.map(q => ({
      ...q,
      images: q.image ? (typeof q.image === 'string' ? JSON.parse(q.image) : q.image) : {},
      analysis: q.solution || q.analysis || '',
      answerContent: q.answer || q.answerContent || '',
      title: q.title || '',
      options: q.options || [],
    }));
  }

  // 降级：Supabase 不可用时从本地文件读取
  if (allQuestions.length === 0) {
    allQuestions = [...readData(QUESTIONS_FILE), ...readData(EXAM_QUESTIONS_FILE)];
  }
  let selectedQuestions = questionIds.map(id => allQuestions.find(q => q.id === id)).filter(Boolean);

  // 创建 styleMap：id -> style（从前端传来的 items 数组）
  const styleMap = {};
  items.forEach(item => {
    if (item.id && item.style) {
      styleMap[item.id] = item.style;
    }
  });
  console.log('[generate-paper] styleMap keys:', Object.keys(styleMap).length, 'sample:', JSON.stringify(Object.values(styleMap).slice(0, 3).map(s => ({hasBorder: s.hasBorder, bg: s.backgroundColor}))));
  console.log('[generate-paper] hasCustomStyle check:', JSON.stringify(selectedQuestions.slice(0, 3).map(q => {
    const s = styleMap[q.id] || {};
    return { id: q.id, hasStyle: !!styleMap[q.id], hasBorder: s.hasBorder, bg: s.backgroundColor };
  })));

  // 生成颜色定义（\definecolor，供 tcolorbox 使用）
  console.log('[generate-paper] generating color defs for', Object.keys(styleMap).length, 'styles');
  const colorDefs = generateColorDefs(styleMap, selectedQuestions);
  console.log('[generate-paper] colorDefs.definitions:', JSON.stringify(colorDefs.definitions));
  console.log('[generate-paper] colorDefs test lookup #4A90D9:', colorDefs.lookup('#4A90D9'));
  console.log('[generate-paper] colorDefs test lookup #F0F7FF:', colorDefs.lookup('#F0F7FF'));
  console.log('[generate-paper] colorDefs test lookup #f5a623:', colorDefs.lookup('#f5a623'));

  // 按题型排序：单选 → 多选 → 填空 → 解答
  const typeOrder = { '单选': 1, '多选': 2, '填空': 3, '解答': 4 };
  selectedQuestions.sort((a, b) => {
    const orderA = typeOrder[a.type] || 99;
    const orderB = typeOrder[b.type] || 99;
    if (orderA !== orderB) return orderA - orderB;
    return 0;
  });

  // 统计各题型数量
  const typeCounts = { '单选': 0, '多选': 0, '填空': 0, '解答': 0 };
  selectedQuestions.forEach(q => { typeCounts[q.type] = (typeCounts[q.type] || 0) + 1; });

  // 生成 LaTeX
  let latex;
  if (paperSize === 'a4') {
    // A4 单栏模板
    latex = '% !TEX program = xelatex\n' +
      '\\documentclass{exam}\n' +
      '\\usepackage{ctex}\n' +
      '\\usepackage{amsmath,amsfonts,amssymb}\n' +
      '\\usepackage{tikz}\n' +
      '\\usepackage{graphicx}\n' +
      '\\usepackage[table,xcdraw,svgnames,HTML]{xcolor}\n' +
      '\\usepackage{geometry}\n' +
      '\\graphicspath{{./images/}}\n\n' +
      '% ===== 题目样式支持（tcolorbox）=====\n' +
      '\\usepackage{tcolorbox}\n' +
      '\\tcbuselibrary{breakable,skins}\n\n' +
      '\\geometry{a4paper,margin=2cm}\n\n' +
      '% ===== 中文化配置 =====\n' +
      '\\usepackage{etoolbox}\n' +
      '\\renewcommand{\\solutiontitle}{\\noindent\\textbf{【解析】}\\enspace}\n' +
      '\\SolutionEmphasis{}\n' +
      '\\unframedsolutions\n\n' +
      '% ===== 缩小标题与正文间距 =====\n' +
      '\\setlength{\\parskip}{0pt}\n' +
      '\\setlength{\\parindent}{0pt}\n\n' +
      '% ===== 页脚：只显示页码数字 =====\n' +
      '\\footer{}{' + '\\thepage' + '}{}\n\n' +
      '\\noprintanswers\n\n' +   // ★ 题目区隐藏答案 — 用末尾\printanswers块显示 ★
      '% 自定义颜色（由前端样式生成）\n' +
      colorDefs.definitions + '\n\n' +
      '\\begin{document}\n\n' +
      // ★ 题头：姓名/得分在左 → 标题居中 → 考试信息在标题下方居中 ★
      '\\noindent 姓名：\\rule{2.5cm}{0.4pt}\\hfill 得分：\\rule{2cm}{0.4pt}\n\n' +
      '\\begin{center}\n' +
      '\\textbf{\\Large ' + (title || '数学试卷') + '}\n\n' +
      '\\small （考试时间：120分钟\\quad 满分：150分）\n' +
      '\\end{center}\n\n' +
      '\\begin{questions}\n\n';
  } else {
    // B4 双栏模板（默认）
    latex = '% !TEX program = xelatex\n' +
      '% ⚠️ 用 twocolumn 文档选项，实现全局连续双栏流\n' +
      '\\documentclass[twocolumn]{exam}\n' +
      '\\usepackage{ctex}\n' +
      '\\usepackage{amsmath,amsfonts,amssymb}\n' +
      '\\usepackage{tikz}\n' +
      '\\usepackage{graphicx}\n' +
      '\\usepackage[table,xcdraw,svgnames,HTML]{xcolor}\n' +
      '\\usepackage{geometry}\n' +
      '\\graphicspath{{./images/}}\n\n' +
      '% ===== 题目样式支持（tcolorbox）=====\n' +
      '\\usepackage{tcolorbox}\n' +
      '\\tcbuselibrary{breakable,skins}\n\n' +
      '% ⚠️ exam 类会干扰 landscape 参数导致纵向输出！手动设置宽高\n' +
      '\\geometry{\n' +
      '  paperwidth = 364mm,\n' +
      '  paperheight = 257mm,\n' +
      '  left = 1cm,\n' +
      '  right = 1cm,\n' +
      '  top = 0.8cm,\n' +
      '  bottom = 0.8cm\n' +
      '}\n\n' +
      '% ===== 中文化配置 =====\n' +
      '\\usepackage{etoolbox}\n' +
      '\\renewcommand{\\solutiontitle}{\\noindent\\textbf{【解析】}\\enspace}\n' +
      '\\SolutionEmphasis{}\n' +
      '\\unframedsolutions\n\n' +
      '% ===== 缩小标题与正文间距 =====\n' +
      '\\setlength{\\parskip}{0pt}\n' +
      '\\setlength{\\parindent}{0pt}\n\n' +
      '% ===== 页脚：只显示页码数字 =====\n' +
      '\\footer{}{' + '\\thepage' + '}{}\n\n' +
      '\\noprintanswers\n\n' +   // ★ 题目区隐藏答案 — 用末尾\printanswers块显示 ★
      '% 自定义颜色（由前端样式生成）\n' +
      colorDefs.definitions + '\n\n' +
      '\\begin{document}\n\n' +
      // ★ 题头：姓名/得分在左 → 标题居中 → 考试信息在标题下方居中 ★
      '\\noindent 姓名：\\rule{2.5cm}{0.4pt}\\hfill 得分：\\rule{2cm}{0.4pt}\n\n' +
      '% ⚠️ 不用 \\maketitle！用手动居中，标题排在左栏顶部\n' +
      '\\begin{center}\n' +
      '\\textbf{\\Large ' + (title || '数学试卷') + '}\n\n' +
      '\\small （考试时间：120分钟\\quad 满分：150分）\n' +
      '\\end{center}\n\n' +
      '\\begin{questions}\n\n';
  }

  const questionBlocks = [];  // 收集题目块（主区域用）
  const answerBlocks = [];    // ★ 收集纯答案块（末尾参考答案区用，不含题目正文和选项）
  let currentType = '';
  selectedQuestions.forEach((q) => {
    if (q.type !== currentType) {
      currentType = q.type;
      let sectionTitle = '';
      if (q.type === '单选') sectionTitle = '一、选择题（每小题5分，共' + (typeCounts['单选'] * 5) + '分）';
      else if (q.type === '多选') sectionTitle = '二、多选题（每小题6分，共' + (typeCounts['多选'] * 6) + '分）';
      else if (q.type === '填空') sectionTitle = '三、填空题（每小题5分，共' + (typeCounts['填空'] * 5) + '分）';
      else if (q.type === '解答') sectionTitle = '四、解答题（共77分）';
      if (sectionTitle) {
        const sec = '\\section*{' + sectionTitle + '}';
        latex += sec + '\n\n';
        questionBlocks.push(sec);
      }
    }
    // 根据 style 决定是否用 tcolorbox 包裹题目
    const style = styleMap[q.id] || {};
    const hasCustomStyle = style.hasBorder || (style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== '#fff' && style.backgroundColor !== '#ffffff');
    const questionLatex = formatQuestionForExam(q, includeAnswer, includeAnalysis);
    
    let questionBlock;
    if (hasCustomStyle) {
      // 用 tcolorbox 包裹（支持背景色、边框、圆角）
      // ⚠️ 不能用 hexToXcolor（[HTML]{...} 的方括号会被 tcolorbox 解析为选项）
      // 改用 \definecolor 定义的颜色名引用
      const bgColor = colorDefs.lookup(style.backgroundColor) || 'white';
      const borderColor = colorDefs.lookup(style.borderColor) || colorDefs.lookup('#ddd') || 'black';
      const borderStyle = style.borderStyle || 'solid';
      const borderRadius = Math.max(0, (style.borderRadius || 6) / 3.6); // px 转 mm（近似）
      const borderWidth = style.hasBorder ? (borderStyle === 'dashed' ? '0.5mm' : '0.8mm') : '0mm';
      
      let tcbOptions = 'colback=' + bgColor + ',colframe=' + borderColor + ',arc=' + borderRadius.toFixed(1) + 'mm,breakable,boxrule=' + borderWidth;
      if (borderStyle === 'dashed') {
        tcbOptions += ',borderline={0.5mm}{0mm}{' + borderColor + '}{dashed}';
      }
      
      // ⚠️ \question 必须跟 tcolorbox 包裹的内容在一起
      // tcolorbox 整个作为 \question 的正文（exam 文档类中 \question 后面跟的是题干内容）
      questionBlock = '\\question\n\\begin{tcolorbox}[' + tcbOptions + ']\n' + questionLatex + '\n\\end{tcolorbox}';
      latex += questionBlock + '\n';
      questionBlocks.push(questionBlock);
    } else {
      questionBlock = '\\question ' + questionLatex;
      latex += questionBlock + '\n';
      questionBlocks.push(questionBlock);
    }
    // 解答题：每题后加书写空白（5cm，题区有效，答案区不受影响）
    if (q.type === '解答') {
      latex += '\\vspace{5cm}\n\n';
    }
    // ★ 构建纯答案块（末尾参考答案区用）
    if (includeAnswer) {
      // ★ 答案和解析合并输出，不重复
      const hasAnalysis = includeAnalysis && q.analysis;
      const mainText = sanitizeAnswer(hasAnalysis ? q.analysis : (q.answer || q.answerContent || ''));
      let answerBlock = '\\question \\textbf{答案：}' + (mainText || '(暂缺)') + '\n';
      answerBlocks.push(answerBlock);
    }
  });

  latex += '\\end{questions}\n';

  // ★ 末尾：参考答案与解析（只显示答案，不重复题目正文和选项）
  if (includeAnswer) {
    latex += '\n\\newpage\n';
    latex += '\\printanswers\n\n';
    latex += '\\section*{参考答案}\n\n';
    latex += '\\begin{questions}\n';
    latex += answerBlocks.join('\n') + '\n';
    latex += '\\end{questions}\n';
  }

  latex += '\\end{document}';

  // ⚠️ 安全检查：LaTeX 中不应出现 [HTML]（已改用 \definecolor 预定义颜色名）
  if (latex.includes('[HTML]')) {
    console.error('[generate-paper] FATAL: LaTeX still contains [HTML]! This WILL cause Undefined color error.');
    const idx = latex.indexOf('[HTML]');
    console.error('[generate-paper] [HTML] found at char', idx, 'context:', latex.substring(Math.max(0, idx - 60), idx + 60));
  } else {
    console.log('[generate-paper] OK: no [HTML] in LaTeX (good).');
  }

  // 收集图片（支持本地和远程 URL）
  const neededImages = new Map();
  selectedQuestions.forEach(q => {
    const imgs = q.images || {};
    Object.entries(imgs).forEach(([key, url]) => {
      const filename = path.basename(url.replace(/[?#].*$/, ''));
      // 远程 URL：直接记下来，后面下载
      if (url.startsWith('http')) {
        neededImages.set(filename, url);
      } else {
        // 本地路径
        const sourcePath = path.join(__dirname, url.replace(/^\//, '').split('?')[0]);
        neededImages.set(filename, sourcePath);
      }
    });
    // 高考题图片：content 中有 <img src="/api/exam-images/xxx.svg">
    if (q.content) {
      const imgMatches = q.content.matchAll(/<img\s+[^>]*src\s*=\s*["']\/api\/exam-images\/([^"']+)["']/gi);
      for (const m of imgMatches) {
        const svgName = m[1];
        const jpgName = svgName.replace(/\.svg$/i, '.jpg');
        const srcPath = path.join(DATA_DIR, 'exam_images', svgName);
        if (fs.existsSync(srcPath)) {
          neededImages.set(jpgName, srcPath);
        }
      }
    }
  });

  // 创建 zip 或编译 PDF
  const sizeSuffix = paperSize === 'a4' ? '_A4' : '';
  const suffix = includeAnswer ? (includeAnalysis ? '_教师版含解析' : '_教师版') : '_学生版';
  const zipFilename = '数学试卷' + suffix + sizeSuffix + '.zip';
  const texFilename = '数学试卷' + suffix + '.tex';
  const pdfFilename = '数学试卷' + suffix + '.pdf';
  const xelatexPath = XELATEX_PATH;

  // 返回 ZIP（LaTeX 源码包）
  if (format === 'zip') {
    try {
      const zip = new JSZip();
      zip.file(texFilename, latex);
      if (neededImages.size > 0) {
        const imagesFolder = zip.folder('images');
        neededImages.forEach((sourcePath, filename) => {
          if (fs.existsSync(sourcePath)) imagesFolder.file(filename, fs.readFileSync(sourcePath));
        });
      }
      const zipContent = await zip.generateAsync({ type: 'nodebuffer' });
      // 自动保存到 data/auto-save
      autoSaveFile(zipContent, zipFilename);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(zipFilename));
      res.send(zipContent);
    } catch (err) {
      console.error('生成试卷失败:', err);
      res.status(500).json({ error: '生成试卷失败：' + err.message });
    }
    return;
  }

  // 返回 PDF（xelatex 编译）
  if (format === 'pdf') {
    // 检查 LaTeX 引擎是否可用
    const engine = USE_TECTONIC ? TECTONIC_PATH : XELATEX_PATH;
    if (!fs.existsSync(engine)) {
      res.status(503).json({ error: 'PDF 编译需要 LaTeX 环境，请下载 ZIP 源码后在本地编译' });
      return;
    }
    const timestamp = Date.now();
    const workDir = path.join(DATA_DIR, 'pdf_exports', `export_${timestamp}`);
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

    // 写入 tex 文件
    const texFile = path.join(workDir, texFilename);
    fs.writeFileSync(texFile, latex, 'utf8');

    // 下载/复制图片到 images/ 子目录
    if (neededImages.size > 0) {
      const imgDir = path.join(workDir, 'images');
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
      for (const [filename, sourcePath] of neededImages) {
        const dest = path.join(imgDir, filename);
        try {
          if (typeof sourcePath === 'string' && sourcePath.startsWith('http')) {
            // 远程 URL：从 Supabase Storage 下载
            await new Promise((resolve, reject) => {
              const file = fs.createWriteStream(dest);
              https.get(sourcePath, (response) => {
                if (response.statusCode !== 200) { reject(new Error('HTTP ' + response.statusCode)); return; }
                response.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
              }).on('error', reject);
            });
          } else if (fs.existsSync(sourcePath)) {
            // 本地文件
            if (sourcePath.toLowerCase().endsWith('.svg') && Resvg) {
              const svgContent = fs.readFileSync(sourcePath, 'utf8');
              const resvg = new Resvg(svgContent, { fitTo: { mode: 'width', value: 800 } });
              fs.writeFileSync(dest, resvg.render().asPng());
            } else {
              await sharp(sourcePath).jpeg({ quality: 92 }).toFile(dest);
            }
          } else {
            console.error('[generate-paper] 图片源不可用:', filename);
          }
        } catch (e) {
          console.error('图片处理失败:', filename, e.message);
        }
      }
    }

    try {
      // 编译两次（处理交叉引用）
      // ⚠️ 必须设置 cwd 为 workDir，否则 \graphicspath{{./images/}} 会基于服务器进程 cwd 找图片
      if (USE_TECTONIC) {
        console.log('[tectonic] 开始编译...');
        let log1 = await runXelatex(engine, ['--outdir', workDir, texFile], workDir);
        console.log('[tectonic 第1遍]\n', log1.slice(0, 500));
        let log2 = await runXelatex(engine, ['--outdir', workDir, texFile], workDir);
        console.log('[tectonic 第2遍]\n', log2.slice(0, 500));
      } else {
        let log1 = await runXelatex(engine, ['-interaction=nonstopmode', '-output-directory=' + workDir, texFile], workDir);
        console.log('[xelatex 第1次编译]\n', log1.slice(0, 500));
        let log2 = await runXelatex(engine, ['-interaction=nonstopmode', '-output-directory=' + workDir, texFile], workDir);
        console.log('[xelatex 第2次编译]\n', log2.slice(0, 500));
      }

      // xelatex 编译出的 PDF 文件名与 tex 文件名一致（不含 sizeSuffix）
      const pdfFile = path.join(workDir, '数学试卷' + suffix + '.pdf');
      if (!fs.existsSync(pdfFile)) {
        // 读取 .log 文件分析错误
        const logFile = path.join(workDir, texFilename.replace('.tex', '.log'));
        let logContent = '';
        if (fs.existsSync(logFile)) logContent = fs.readFileSync(logFile, 'utf8');
        const errorLines = logContent.split('\n').filter(l => l.startsWith('!')).slice(0, 5);
        console.error('PDF 未生成！提取到的错误行:', errorLines);
        throw new Error('PDF 未生成。LaTeX 错误: ' + (errorLines.join('; ') || '未知错误（请查看服务器日志）'));
      }

      const pdfBuffer = fs.readFileSync(pdfFile);

      // ===== PDF 完整性校验 =====
      if (pdfBuffer.length < 1024) {
        throw new Error('PDF 文件不完整（仅 ' + pdfBuffer.length + ' 字节），xelatex 编译可能被中断。请重试导出。');
      }
      const header = pdfBuffer.slice(0, 5).toString('ascii');
      if (header !== '%PDF-') {
        throw new Error('PDF 文件头异常，不是有效的 PDF 文件');
      }
      // 检查 %%EOF 结尾标记（允许尾部有少量空白）
      const tail = pdfBuffer.slice(-20).toString('latin1');
      if (!tail.includes('%%EOF')) {
        console.warn('[generate-paper] 警告: PDF 缺少 %%EOF 结尾标记（可能仍可打开）');
      }
      console.log('[generate-paper] PDF 校验通过, 大小:', (pdfBuffer.length / 1024).toFixed(1), 'KB');

      // 自动保存到 data/auto-save
      autoSaveFile(pdfBuffer, pdfFilename);

      // ===== 保存到「已下载的试卷」 =====
      try {
        const paperId = 'paper_' + Date.now();
        const paperDest = path.join(PAPERS_DIR, paperId + '.pdf');
        fs.writeFileSync(paperDest, pdfBuffer);
        const papers = readPapers();
        papers.unshift({
          id: paperId,
          title: title || '数学试卷',
          filename: pdfFilename,
          size: pdfBuffer.length,
          createdAt: new Date().toISOString(),
          questionCount: selectedQuestions.length,
          includeAnswer,
          includeAnalysis
        });
        writePapers(papers);
        console.log('已保存到已下载试卷:', paperId, pdfFilename);
      } catch (e) {
        console.error('保存到已下载试卷失败（不影响下载）:', e.message);
      }
      // ===== 保存结束 =====

      res.setHeader('Content-Type', 'application/pdf');
      if (req.query.preview === '1') {
        // 预览模式：浏览器内直接打开
        res.setHeader('Content-Disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(pdfFilename));
      } else {
        // 下载模式：弹出下载对话框
        res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(pdfFilename));
      }
      res.send(pdfBuffer);

      // 清理临时文件（1分钟后）
      setTimeout(() => {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
      }, 60000);

    } catch (err) {
      console.error('PDF 编译失败:', err);
      const logFile = path.join(workDir, texFilename.replace('.tex', '.log'));
      let errorDetail = err.message;
      if (fs.existsSync(logFile)) {
        const log = fs.readFileSync(logFile, 'utf8');
        const lines = log.split('\n');
        // 提取前几行错误信息
        const errorLines = lines.filter(l => l.startsWith('!')).slice(0, 3);
        if (errorLines.length) errorDetail = errorLines.join('；');
        // 打印完整日志以便调试
        console.error('=== XeLaTeX 完整日志 ===');
        console.error(log);
        console.error('=== 日志结束 ===');
      }
      res.status(500).json({ error: 'PDF 编译失败：' + errorDetail });
      // 调试期间保留临时文件，注释掉清理
      // try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
    }
    return;
  }
});

// ========== LaTeX 实时预览接口（服务端编译）==========
const PREVIEW_DIR = path.join(__dirname, 'data', 'previews');
if (!fs.existsSync(PREVIEW_DIR)) fs.mkdirSync(PREVIEW_DIR, { recursive: true });

app.post('/api/preview-latex', async (req, res) => {
  const { latex, format = 'pdf' } = req.body;
  if (!latex || typeof latex !== 'string') {
    return res.status(400).json({ error: '缺少 latex 参数' });
  }

  const timestamp = Date.now();
  const workDir = path.join(PREVIEW_DIR, `preview_${timestamp}`);
  fs.mkdirSync(workDir, { recursive: true });

  // 判断是否是完整文档（包含 \documentclass）
  const isFullDoc = /\\documentclass/.test(latex);

  let fullLatex;
  if (isFullDoc) {
    fullLatex = latex;
  } else {
    // 包装成最小可编译文档
    fullLatex = '\\documentclass[12pt]{article}\n' +
      '\\usepackage{ctex}\n' +
      '\\usepackage{amsmath,amssymb,amsfonts}\n' +
      '\\usepackage{geometry}\n' +
      '\\geometry{a4paper,margin=2cm}\n' +
      '\\begin{document}\n\n' +
      latex + '\n\n' +
      '\\end{document}\n';
  }

  // ===== 提取并复制图片 =====
  // 扫描 LaTeX 中的 \includegraphics{images/filename} 引用
  const imgRefs = new Set();
  const imgRe = /\\includegraphics(?:\[[^\]]*\])?\{images\/([^}]+)\}/g;
  let im;
  while ((im = imgRe.exec(fullLatex)) !== null) {
    imgRefs.add(im[1]);
  }
  if (imgRefs.size > 0) {
    const imgDir = path.join(workDir, 'images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

    // 递归搜索图片源文件（来自 uploads/images/ 和 uploads/doc2x_images/）
    for (const filename of imgRefs) {
      // 先在 uploads/images/ 找
      const src1 = path.join(IMAGES_DIR, filename);
      let srcPath = fs.existsSync(src1) ? src1 : null;

      // 没找到则在 uploads/doc2x_images/ 下递归搜索
      if (!srcPath) {
        const searchRoot = path.join(__dirname, 'uploads', 'doc2x_images');
        if (fs.existsSync(searchRoot)) {
          const found = findFileRecursive(searchRoot, filename);
          if (found) srcPath = found;
        }
      }

      if (srcPath) {
        const dest = path.join(imgDir, filename);
        try {
          await sharp(srcPath).jpeg({ quality: 92 }).toFile(dest);
        } catch (e) {
          fs.copyFileSync(srcPath, dest);
        }
      } else {
        console.warn('[preview-latex] 图片未找到:', filename);
      }
    }

    // 确保 LaTeX 有 \graphicspath{{./images/}} 和 \usepackage{graphicx}
    if (!/\\graphicspath/.test(fullLatex)) {
      const gfxPathLine = '\\graphicspath{{./images/}}\n';
      // 插入到 \begin{document} 之前
      fullLatex = fullLatex.replace(/\\begin\{document\}/, gfxPathLine + '\\begin{document}');
    }
    if (!/\\usepackage\{graphicx\}/.test(fullLatex)) {
      // 插入到 \documentclass 之后
      fullLatex = fullLatex.replace(/(\\documentclass[^\n]*\n)/, '$1\\usepackage{graphicx}\n');
    }
  }

  const texFile = path.join(workDir, 'preview.tex');
  fs.writeFileSync(texFile, fullLatex, 'utf8');

  try {
    // 调用 xelatex 编译两次（处理交叉引用）
    const xelatexPath = XELATEX_PATH;
    const args = ['-interaction=nonstopmode', '-output-directory=' + workDir, texFile];

    await execFileAsync(xelatexPath, args);
    await execFileAsync(xelatexPath, args);

    const pdfFile = path.join(workDir, 'preview.pdf');
    if (!fs.existsSync(pdfFile)) {
      throw new Error('PDF 文件未生成');
    }

    if (format === 'svg') {
      // pdf2svg 转换（如果可用）
      // 暂不支持，返回 PDF
      return res.status(400).json({ error: 'SVG 格式暂不支持，请使用 PDF' });
    }

    // 返回 PDF
    const pdfBuffer = fs.readFileSync(pdfFile);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=preview.pdf');
    res.send(pdfBuffer);

    // 清理临时文件（延迟执行，避免影响响应）
    setTimeout(() => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (e) {
        // 忽略清理错误
      }
    }, 60000);

  } catch (err) {
    console.error('LaTeX 编译失败:', err);
    // 尝试读取日志文件返回错误信息
    const logFile = path.join(workDir, 'preview.log');
    let errorDetail = err.message;
    if (fs.existsSync(logFile)) {
      const log = fs.readFileSync(logFile, 'utf8');
      const errorMatch = log.match(/!\s*(.+?)(?:\r?\n|$)/);
      if (errorMatch) errorDetail = errorMatch[1];
    }
    res.status(500).json({ error: 'LaTeX 编译失败：' + errorDetail });
    // 清理
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ========== AI 解析 API ==========
// 调用 DeepSeek API 生成题目解析
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

app.post('/api/ai-analysis', async (req, res) => {
  try {
    const { title, content, options, type } = req.body;

    if (!content) {
      return res.status(400).json({ error: '题目内容不能为空' });
    }

    // 构建 prompt：不让 AI 看到答案，让它独立解题
    let prompt = '请解答以下高中数学题目，并给出详细的解题过程和解析。\n\n';
    prompt += `题型：${type || '未知'}\n`;
    if (title) prompt += `标题：${title}\n`;
    prompt += `题目内容：\n${content}\n`;
    if (options && options.length > 0) {
      prompt += `\n选项：\n`;
      const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
      options.forEach((opt, i) => {
        prompt += `${labels[i]}. ${opt}\n`;
      });
    }

    prompt += `\n要求（必须严格遵守）：
1. 先独立解答题目，得出正确答案
2. 解析风格参考高考标准答案：简洁、直接，不写"第一步、第二步"
3. 简单计算步骤可以省略，只写关键步骤和最终结果
4. 严禁使用行间公式（\\[...\\]），所有公式必须写成行内公式（\\(...\\)），包括多行公式也直接用 \\(...\\) 写在同一行，绝不允许公式独占一行
5. 尽量减少文字叙述，不要重复题目条件，不要逐条罗列已知条件，直接写解题过程
6. 如有多种解法，请一并列出（每行一个解法，不要分多段）
7. 最后加一个"【方法总结】"段落：总结本题类型、通法通法、易错点
8. 输出纯文本，不要使用 Markdown 代码块标记
9. 直接输出解析内容，不要加"解析："等前缀`;

    const requestBody = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是位经验丰富的中国高中数学教师，擅长写高考标准答案风格的解析。你的特点是：公式全部用行内格式，不写分步骤序号，不重复题目条件，直接给出解题过程。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 4000,
    };

    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('DeepSeek API 错误:', response.status, errText);
      return res.status(500).json({ error: `AI 服务错误 (${response.status})，${errText.slice(0, 200)}` });
    }

    const data = await response.json();
    const aiAnalysis = data.choices?.[0]?.message?.content?.trim() || '';

    if (!aiAnalysis) {
      return res.status(500).json({ error: 'AI 返回内容为空' });
    }

    res.json({ analysis: aiAnalysis });
  } catch (err) {
    console.error('AI 解析失败:', err);
    res.status(500).json({ error: 'AI 解析失败：' + (err instanceof Error ? err.message : String(err)) });
  }
});

// ========== LLM 结构化解析 ==========
// 用 DeepSeek 对 OCR 文本做语义理解，提取题型/选项/答案
// 比纯正则更鲁棒：不受 \mathrm{B}、\begin{array} 等排版干扰

const LLM_CONCURRENCY = 3; // 并行请求数

/**
 * 用 LLM 解析单道题的 OCR 文本，返回结构化信息
 * @returns {{ type, options, answer, cleanContent } | null}
 */
async function llmParseQuestion(rawContent, questionNumber) {
  const prompt = `你是数学题目结构化解析专家。请分析以下OCR识别的高中数学题目文本，提取结构化信息。
只输出JSON，不要markdown代码块，不要任何解释。

题目文本：
"""
${rawContent}
"""

输出格式（严格JSON，不要有其他内容）：
{"type":"","options":[],"answer":"","cleanContent":""}

字段说明：
- type: "单选"(有ABCD四个选项) / "多选"(有ABCD且题干含"多个正确""全部正确"等) / "填空"(有下划线_或空白) / "解答"(要求证明/解答/计算/化简)
- options: 提取A./B./C./D.标记的完整选项文本数组，如["f(x) 是奇函数","f(x) 是偶函数"]。⚠️重要：选项内容不要带 A. B. C. D. 前缀，不要带 \item 前缀，只要纯文本内容！被LaTeX包裹的选项标记（如\mathrm{B}.）也是选项B的标记，照常提取但去掉标记只留内容
- answer: 如果文本中能看到正确答案标记则填写（单选如"A"，多选如"AB"），否则填""。⚠️只填答案字母/数字，不要包含【详解】【解析】或任何解释文字
- cleanContent: 清理后的题目正文，去除选项文本、\item标记、\begin{itemize}等LaTeX环境，但保留LaTeX公式、图片标记<img>和题号

关键提醒：
1. 选项可能跨行分布（A和B一行，C和D另一行），必须全部提取
2. 选项文本内可能包含LaTeX公式，原文保留不要改动
3. 如果文本末尾有"（   ）"之类的答题空，去掉它
4. 题干开头的标签如【单选】【多选】、来源如（2024·新课标卷）等保留`;

  try {
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是数学题目结构化解析专家。只输出JSON，不输出任何其他内容。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[LLM Parse] Q${questionNumber}: API error ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const rawOutput = data.choices?.[0]?.message?.content?.trim() || '';

    // 尝试从输出中提取 JSON（LLM 可能在 JSON 外包裹了说明文字）
    let jsonStr = rawOutput;
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);

    // 验证必填字段
    if (!parsed.type) parsed.type = '单选';
    if (!Array.isArray(parsed.options)) parsed.options = [];
    if (typeof parsed.answer !== 'string') parsed.answer = '';
    if (typeof parsed.cleanContent !== 'string' || !parsed.cleanContent) parsed.cleanContent = rawContent;

    // === 后清理：去掉 LLM 可能输出的 \item 前缀等残留 ===
    parsed.options = parsed.options.map(opt => {
      let s = String(opt).trim();
      s = s.replace(/^\\?\item\s*/i, '');      // 去掉 \item 前缀
      s = s.replace(/^[A-D][\.．\uFF0E)]\s*/, '');  // 去掉 A. B. C. D. 前缀
      return s.trim();
    }).filter(Boolean);

    // 答案只保留纯字母/数字，去掉详解等
    if (/【.*?详|【.*?解|【.*?分/.test(parsed.answer)) {
      const m = parsed.answer.match(/^([A-D]{1,4})/);
      if (m) parsed.answer = m[1];
      else parsed.answer = '';
    }
    // cleanContent 去掉 LaTeX 列表环境残留
    parsed.cleanContent = parsed.cleanContent
      .replace(/\\begin\{itemize\}|\\end\{itemize\}|\\begin\{enumerate\}|\\end\{enumerate\}/g, '')
      .replace(/^\\?\item\s+/gm, '')
      .trim();

    console.log(`[LLM Parse] Q${questionNumber}: type=${parsed.type}, opts=${parsed.options.length}, answer="${parsed.answer}"`);
    return parsed;
  } catch (e) {
    console.error(`[LLM Parse] Q${questionNumber}: ${e.message}`);
    return null;
  }
}

/**
 * 批量 LLM 解析（并行 + 限流）
 */
async function llmReparseQuestions(questions, logPrefix) {
  if (questions.length === 0) return questions;

  console.log(`[LLM Parse] ${logPrefix}: Starting reparse of ${questions.length} questions...`);

  const updated = [...questions];
  let successCount = 0;

  // 分批并行处理
  for (let i = 0; i < questions.length; i += LLM_CONCURRENCY) {
    const batch = questions.slice(i, i + LLM_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map((q, batchIdx) => {
        const globalIdx = i + batchIdx;
        const rawContent = q.content || '';
        if (!rawContent.trim()) return Promise.resolve(null);
        return llmParseQuestion(rawContent, q.number);
      })
    );

    batchResults.forEach((result, batchIdx) => {
      const globalIdx = i + batchIdx;
      if (result.status === 'fulfilled' && result.value) {
        const llm = result.value;
        const q = updated[globalIdx];

        // 更新题型（LLM 判断更准）
        if (llm.type && ['单选', '多选', '填空', '解答'].includes(llm.type)) {
          q.type = llm.type;
        }

        // 更新选项（LLM 提取更完整）
        if (llm.options && llm.options.length > 0) {
          // 清洗选项：去掉选项文本前的 \item / A. B. C. D. 等前缀
          q.options = llm.options.map(opt => {
            let s = opt.trim();
            s = s.replace(/^\\?\item\s*/i, '');       // \item 前缀
            s = s.replace(/^[A-D][\.．\uFF0E)]\s*/, '');  // A. 前缀
            return s.trim();
          }).filter(Boolean);
        }

        // 更新答案（如果 LLM 识别到了）
        if (llm.answer && llm.answer.trim()) {
          q.answer = llm.answer.trim();
        }

        // 更新题干（清理后的版本）
        // ⚠️ 安全检查：如果 LLM 返回的 cleanContent 以"答案"/"解析"开头，
        //    说明 LLM 把答案解析当成了题干，拒绝更新！
        if (llm.cleanContent && llm.cleanContent.trim() && llm.cleanContent.trim() !== q.content) {
          let cc = llm.cleanContent.trim();
          const looksLikeAnswer = /^(答案|【.*?详|【.*?解|【.*?分|解[：:]\s*|证明略)/.test(cc)
            || (cc.length > 20 && /^答案/.test(cc.substring(0, 10)));
          if (!looksLikeAnswer) {
            // 去掉 LLM 可能留下的多余答题空
            cc = cc.replace(/[\s]*（\s*[）)][\s]*（\s*[）)]+[\s]*$/g, '（ ）').replace(/[\s]*（\s*[）)][\s]*$/, '').trim();
            q.content = cc;
          } else {
            console.warn(`[LLM Parse] Q${q.number}: ⚠️ cleanContent looks like answer/analysis, keeping original content`);
          }
        }

        successCount++;
      } else if (result.status === 'rejected') {
        console.error(`[LLM Parse] Q${updated[globalIdx].number}: rejected - ${result.reason}`);
      }
    });
  }

  console.log(`[LLM Parse] ${logPrefix}: Done — ${successCount}/${questions.length} parsed successfully`);
  return updated;
}

// ========== 已下载的试卷 API ==========

// GET /api/papers - 列出所有已下载的试卷
app.get('/api/papers', (req, res) => {
  try {
    const papers = readPapers();
    res.json(papers);
  } catch (e) {
    res.status(500).json({ error: '读取试卷列表失败：' + e.message });
  }
});

// GET /api/papers/:id/file - 下载或预览 PDF（兼容旧格式 fileUrl）
app.get('/api/papers/:id/file', (req, res) => {
  try {
    const { id } = req.params;
    const papers = readPapers();
    const paper = papers.find(p => p.id === id);
    if (!paper) return res.status(404).json({ error: '试卷不存在' });

    // 优先使用新格式路径（data/papers/）
    let filePath = path.join(PAPERS_DIR, id + '.pdf');
    // 兼容旧格式：使用 fileUrl（相对于项目根目录）
    if (!fs.existsSync(filePath) && paper.fileUrl) {
      filePath = path.join(__dirname, paper.fileUrl);
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF 文件不存在' });

    const buffer = fs.readFileSync(filePath);
    const isPreview = req.query.preview === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', (isPreview ? 'inline' : 'attachment') + '; filename*=UTF-8\'\'' + encodeURIComponent(paper.filename || paper.fileName || '试卷.pdf'));
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: '读取 PDF 失败：' + e.message });
  }
});

// DELETE /api/papers/:id - 删除指定试卷
app.delete('/api/papers/:id', (req, res) => {
  try {
    const { id } = req.params;
    let papers = readPapers();
    const paper = papers.find(p => p.id === id);
    if (!paper) return res.status(404).json({ error: '试卷不存在' });

    // 删除 PDF 文件
    const filePath = path.join(PAPERS_DIR, id + '.pdf');
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // 从元数据中移除
    papers = papers.filter(p => p.id !== id);
    writePapers(papers);
    res.json({ success: true, message: '已删除' });
  } catch (e) {
    res.status(500).json({ error: '删除失败：' + e.message });
  }
});

// ========== 批量录题 API（ZIP/TeX 模式）==========
require('./batch-import.cjs')(app, path, fs, JSZip, sharp);

// ========== PDF 批量录题 API（Doc2X 解析模式 — 内联版）==========
// 放在 batch-import 之前以确保路由注册


// ★ 内联兜底：确保 pdf-batch 路由加载
const crypto = require('crypto');
const { URL } = require('url');
const PDF_TASKS_FILE = path.join(DATA_DIR, 'doc2x_tasks.json');
const PDF_IMAGES_DIR = path.join(__dirname, 'uploads', 'doc2x_images');

// ========= Qwen 多模态 LaTeX 识别配置 =========
// 调用 DashScope Qwen3-VL-Plus 多模态模型，PDF 逐页截图后直接识别为 LaTeX
// 桥接脚本：D:\math-website\qwen_vlm_bridge.py
const QWEN_VLM_PYTHON = 'D:/Codex/MathFormula2Tex/.venv/Scripts/python.exe';
const QWEN_VLM_SCRIPT = 'D:/math-website/qwen_vlm_bridge.py';
const QWEN_VLM_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

// ========= PaddleOCR-VL（已移除，保留注释备用）=========
// // ========== PaddleOCR-VL 本地部署配置 ==========
// // 用户已在 D:/PaddleOCR-VL 部署好 PaddleOCR-VL-1.6（CPU 模式，venv 隔离环境）
// // 通过子进程调用 parse_document.py 解析 PDF
// const PADDLE_VL_VENV = 'D:\\PaddleOCR-VL\\venv\\Scripts\\python.exe';
// const PADDLE_VL_SCRIPT = 'D:\\PaddleOCR-VL\\parse_document.py';
// // 单 PDF 最长等待时间（毫秒）— CPU 模式慢，留宽裕
// const PADDLE_VL_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

function readPdfTasks() {
  if (!fs.existsSync(PDF_TASKS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(PDF_TASKS_FILE, 'utf8')); }
  catch (e) { return []; }
}
function writePdfTasks(t) { fs.writeFileSync(PDF_TASKS_FILE, JSON.stringify(t, null, 2), 'utf8'); }

// GET /api/pdf-batch/list（内联版兜底）
app.get('/api/pdf-batch/list', (req, res) => {
  const tasks = readPdfTasks();
  res.json(tasks);
});

// GET /api/pdf-batch/:taskId（内联版兜底）
app.get('/api/pdf-batch/:taskId', (req, res) => {
  const tasks = readPdfTasks();
  const task = tasks.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

// GET /api/pdf-batch/:taskId/pdf — 返回原始 PDF 供前端渲染
app.get('/api/pdf-batch/:taskId/pdf', (req, res) => {
  const tasks = readPdfTasks();
  const task = tasks.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const pdfPath = path.join(PDF_IMAGES_DIR, req.params.taskId, 'original.pdf');
  if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'PDF 文件不存在' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  fs.createReadStream(pdfPath).pipe(res);
});

// GET /api/pdf-batch/:taskId/page-info — 返回逐页题号映射
app.get('/api/pdf-batch/:taskId/page-info', (req, res) => {
  const tasks = readPdfTasks();
  const task = tasks.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  // 从 per-page markdown 计算每页包含的题号
  const pageMd = task.pageMd || [];
  const totalPages = task.totalPages || pageMd.length;
  const pages = [];
  for (let i = 0; i < totalPages; i++) {
    const md = pageMd[i] || '';
    const nums = [...md.matchAll(/(?:\n|^)\s*(\d{1,2})[.、．]\s*/g)].map(m => parseInt(m[1]));
    pages.push({ page: i + 1, questionNumbers: [...new Set(nums)].sort((a, b) => a - b) });
  }
  res.json({ pages, totalPages });
});

// PUT /api/pdf-batch/:taskId/question（内联版兜底）
app.put('/api/pdf-batch/:taskId/question', (req, res) => {
  const { questionIndex, updates } = req.body;
  const tasks = readPdfTasks();
  const task = tasks.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!task.questions[questionIndex]) return res.status(400).json({ error: '题目索引无效' });
  Object.assign(task.questions[questionIndex], updates);
  writePdfTasks(tasks);
  res.json({ success: true });
});

// POST /api/pdf-batch/:taskId/llm-reparse - 手动触发 LLM 重解析（测试用）
app.post('/api/pdf-batch/:taskId/llm-reparse', async (req, res) => {
  try {
    const tasks = readPdfTasks();
    const task = tasks.find(t => t.id === req.params.taskId);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!task.questions || task.questions.length === 0) return res.status(400).json({ error: '任务没有题目' });

    console.log(`[LLM Reparse] Manual trigger for ${req.params.taskId}`);
    const updated = await llmReparseQuestions(task.questions, req.params.taskId);
    task.questions = updated;
    writePdfTasks(tasks);
    res.json({ success: true, questionCount: updated.length });
  } catch (e) {
    console.error('[LLM Reparse] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pdf-batch/:taskId/confirm（内联版兜底）
app.post('/api/pdf-batch/:taskId/confirm', (req, res) => {
  try {
    const tasks = readPdfTasks();
    const task = tasks.find(t => t.id === req.params.taskId);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const questionIds = req.body.questionIds;
    const questionsToSave = task.questions.filter((_, i) => questionIds ? questionIds.includes(i) : true);
    const questionsPath = path.join(DATA_DIR, 'questions.json');
    let existing = [];
    if (fs.existsSync(questionsPath)) {
      try { existing = JSON.parse(fs.readFileSync(questionsPath, 'utf8')); } catch(e) { existing = []; }
    }
    let savedCount = 0;
    const savedIds = [];
    for (const q of questionsToSave) {
      // === 清理选项：去掉 \item / item 前缀和多余空白 ===
      let cleanOptions = (q.options || []).map(opt => {
        let s = String(opt).trim();
        // 去掉 stray backslash-space 前缀（如 "\ \( f(x) \)" → "\( f(x) \)"）
        s = s.replace(/^\\\s+(?=\()/, '');
        // 去掉 \item 前缀（LaTeX 列表环境残留）
        s = s.replace(/^\\?item\s*/i, '');
        // 去掉 "A." "B." 等已由题号表示的前缀（保留内容部分）
        s = s.replace(/^[A-D][\.．\uFF0E)]\s*/, '');
        return s.trim();
      }).filter(Boolean);

      // === 防御：检测选项全部重复（所有选项内容完全相同） ===
      const isChoiceQ = q.type === '单选' || q.type === '多选';
      if (isChoiceQ && cleanOptions.length >= 4 && new Set(cleanOptions.map(o => o.replace(/\s/g, ''))).size === 1) {
        console.error(`[Confirm] ⚠️ Q${q.number} 选项全部重复！已拒绝入库，请在PDF录题界面修复后再导入`);
        continue; // 跳过此题，不收入库
      }

      // === 清理答案：只保留纯答案字母，去掉【详解】【解析】等解析文本 ===
      let rawAnswer = String(q.answer || '').trim();
      let cleanAnswer = rawAnswer;
      // 如果答案中包含详解/解析标记或过长(>15字符)，截取前面的纯答案
      if (/【.*?详|【.*?解|【.*?分/.test(cleanAnswer)) {
        const ansMatch = cleanAnswer.match(/^([A-D]{1,4}|[\d\s\.\,\+\-\*\/\\\(\)\{\}\^\[\]\\a-z\=\>\<\≤\≥\√\π\∅\∞\∈\∪\∩\{\}\s]{1,30})/);
        cleanAnswer = ansMatch ? ansMatch[1].trim() : '';
      } else if (cleanAnswer.length > 20 && /[（(].*[）)]/.test(cleanAnswer)) {
        // 答案过长且包含括号说明文字，尝试提取短答案
        const shortMatch = cleanAnswer.match(/^[A-D]{1,4}/);
        cleanAnswer = shortMatch ? shortMatch[0] : cleanAnswer.slice(0, 15);
      }
      // 去掉答案中的 LaTeX 块（如 \[...\] 或 $$...$$）
      cleanAnswer = cleanAnswer.replace(/\$\$[\s\S]*?\$\$|\\[[\s\S]*?\\]/g, '').trim();

      // === 清理 content 中的代码残留 ===
      let cleanContent = (q.content || '').trim();
      // 去掉行首 \item 前缀
      cleanContent = cleanContent.replace(/^\\?item\s+/gm, '');
      // 去掉 \begin{...} \end{...} 残留的 itemize/enumerate 标记
      cleanContent = cleanContent.replace(/\\begin\{itemize\}|\\end\{itemize\}|\\begin\{enumerate\}|\\end\{enumerate\}/g, '');

      const newQ = {
        id: 'q-' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
        title: `${q.number}.`,
        content: cleanContent,
        answerContent: '',
        analysis: q.analysis || '',
        options: cleanOptions,
        answer: cleanAnswer,
        difficulty: q.difficulty || task.defaults.difficulty || '中',
        type: q.type || '单选',
        grade: task.defaults.grade || '高一',
        categoryId: task.defaults.categoryId || '',
        categoryName: task.defaults.categoryName || '',
        tags: [],
        source: task.filename ? task.filename.replace(/\.pdf$/i, '') : '',
        images: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      // === 图片处理：所有图片都插入 content（修复只插第一张的 bug）===
      if (q.images && q.images.length > 0) {
        const imgKeys = [];
        q.images.forEach((imgUrl, idx) => {
          const key = `img_${Date.now()}_${idx}`;
          newQ.images[key] = imgUrl;
          imgKeys.push(key);
        });
        // 如果 content 中还没有任何 \img{} 引用，把所有图片追加到末尾
        if (!cleanContent.includes('\\img{')) {
          newQ.content = cleanContent + '\n' + imgKeys.map(k => `\\img{${k}}`).join('\n');
        } else {
          // 已有图片引用，确保所有 key 都在 images 中即可（content 中的引用保持不变）
        }
      }
      existing.push(newQ);
      savedIds.push(newQ.id);
      savedCount++;
    }
    fs.writeFileSync(questionsPath, JSON.stringify(existing, null, 2), 'utf8');
    // 部分入库：只移除已入库的题目，保留未入库的
    // 按 index 降序排列删除，避免索引偏移
    const sortedIds = [...(questionIds || [])].sort((a, b) => b - a);
    for (const idx of sortedIds) {
      if (idx >= 0 && idx < task.questions.length) {
        task.questions.splice(idx, 1);
      }
    }
    task.questionCount = task.questions.length;
    // 只有当所有题目都已入库才标记为 confirmed
    if (task.questionCount === 0) {
      task.status = 'confirmed';
    }
    writePdfTasks(tasks);
    const bakPath = path.join(DATA_DIR, `questions.json.bak-${Date.now()}.json`);
    fs.writeFileSync(bakPath, JSON.stringify(existing, null, 2), 'utf8');
    console.log(`[PDF Batch Inline] Confirmed ${savedCount} questions, remaining: ${task.questionCount}`);
    res.json({ success: true, savedCount, savedIds, updatedTask: task });
  } catch (err) {
    res.status(500).json({ error: '入库失败：' + err.message });
  }
});

// DELETE /api/pdf-batch/:taskId（内联版兜底）
app.delete('/api/pdf-batch/:taskId', (req, res) => {
  try {
    const tasks = readPdfTasks();
    const idx = tasks.findIndex(t => t.id === req.params.taskId);
    if (idx === -1) return res.status(404).json({ error: '任务不存在' });
    const taskDir = path.join(PDF_IMAGES_DIR, req.params.taskId);
    if (fs.existsSync(taskDir)) fs.rmSync(taskDir, { recursive: true, force: true });
    tasks.splice(idx, 1);
    writePdfTasks(tasks);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '删除失败：' + err.message }); }
});

app.use('/uploads/doc2x_images', express.static(PDF_IMAGES_DIR));

// ========== Doc2X 上传解析核心 ==========
// POST /api/pdf-batch/upload — 上传 PDF，调用 Doc2X 解析并下载图片
app.post('/api/pdf-batch/upload', async (req, res) => {
  try {
    const { filename, fileData, grade, difficulty, categoryId, categoryName, engine } = req.body;
    if (!filename || !fileData) return res.status(400).json({ error: '缺少文件名或文件数据' });

    // 选择解析引擎：mineru-local（默认，本地 magic-pdf）| qwen-vlm（Qwen多模态 LaTeX 直出）| mineru-api（云端 v4）| doc2x
    const useEngine = (engine || 'mineru-local').toLowerCase();
    if (useEngine === 'mineru-api' && !MINERU_TOKEN) {
      console.warn('[PDF Batch] MINERU_TOKEN 未配置，回退到 mineru-local');
    }
    const actualEngine = (useEngine === 'mineru-api' && MINERU_TOKEN) ? 'mineru-api'
      : (useEngine === 'qwen-vlm') ? 'qwen-vlm'
      : (useEngine === 'doc2x') ? 'doc2x'
      : 'mineru-local'; // 默认本地解析

    const taskId = 'task_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const taskDir = path.join(PDF_IMAGES_DIR, taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    const pdfBuffer = Buffer.from(fileData, 'base64');
    fs.writeFileSync(path.join(taskDir, 'original.pdf'), pdfBuffer);

    // 创建任务（processing 状态）
    const tasks = readPdfTasks();
    tasks.unshift({
      id: taskId, filename, status: 'processing',
      createdAt: new Date().toISOString(), totalPages: 0, questionCount: 0,
      defaults: { grade: grade || '高一', difficulty: difficulty || '中', categoryId: categoryId || '', categoryName: categoryName || '' },
      questions: [], error: null,
      engine: actualEngine // 记录使用的引擎
    });
    writePdfTasks(tasks);

    res.json({ taskId, status: 'processing', message: `PDF 已提交，正在用 ${actualEngine === 'mineru-local' ? 'MinerU 本地解析' : actualEngine === 'qwen-vlm' ? 'Qwen 多模态 LaTeX 识别' : actualEngine === 'mineru-api' ? 'MinerU v4 精准解析' : 'Doc2X'} 解析...`, engine: actualEngine });

    // === 异步解析 ===
    try {
      // ===== 预处理：自动检测 ZIP/LaTeX 并编译为真正的 PDF =====
      // 这样 Doc2X 和 MinerU 都能正确处理
      console.log(`[PDF Batch] ${taskId}: 开始预处理...`);
      try {
        const compiledPdfPath = await preprocessPdfBuffer(pdfBuffer, taskDir, taskId);
        if (compiledPdfPath && fs.existsSync(compiledPdfPath)) {
          pdfBuffer = fs.readFileSync(compiledPdfPath);
          // 也更新 original.pdf 为编译后的 PDF
          fs.writeFileSync(path.join(taskDir, 'original.pdf'), pdfBuffer);
          console.log(`[PDF Batch] ${taskId}: ✅ 预处理完成，使用编译后的 PDF (${(pdfBuffer.length/1024).toFixed(1)} KB)`);
          const tks2 = readPdfTasks();
          const t2 = tks2.find(x => x.id === taskId);
          if (t2) { t2.processingNote = 'LaTeX 源码已自动编译为 PDF 后解析'; writePdfTasks(tks2); }
        } else {
          console.log(`[PDF Batch] ${taskId}: 无需预处理，直接使用原始 PDF`);
        }
      } catch (preErr) {
        console.error(`[PDF Batch] ${taskId}: 预处理失败:`, preErr.message);
        const tks3 = readPdfTasks();
        const t3 = tks3.find(x => x.id === taskId);
        if (t3) { t3.status = 'failed'; t3.error = '文件格式错误：' + preErr.message; writePdfTasks(tks3); }
        return; // 不继续处理
      }
      
      // 现在用处理过的 pdfBuffer（可能是编译后的 PDF）
      if (actualEngine === 'mineru-local') {
        await processPdfWithMinerULocal(taskId, pdfBuffer, taskDir, tasks[0].defaults);
      } else if (actualEngine === 'qwen-vlm') {
        await processPdfWithQwenVLM(taskId, pdfBuffer, taskDir, tasks[0].defaults);
      } else if (actualEngine === 'mineru-api') {
        await processPdfWithMinerU(taskId, pdfBuffer, taskDir, tasks[0].defaults);
      } else {
        await processPdfWithDoc2X(taskId, pdfBuffer, taskDir, tasks[0].defaults);
      }
    } catch (e) {
      console.error(`[PDF Batch] ${taskId} (${actualEngine}): Error - ${e.message}`);
      const tks = readPdfTasks();
      const t = tks.find(x => x.id === taskId);
      if (t) { t.status = 'failed'; t.error = e.message; writePdfTasks(tks); }
    }
  } catch (err) {
    console.error('[PDF Batch] Upload error:', err);
    res.status(500).json({ error: '上传失败：' + err.message });
  }
});

// Doc2X 异步处理核心
async function processPdfWithDoc2X(taskId, pdfBuffer, taskDir, defaults) {
  const DOC2X_KEY = process.env.DOC2X_KEY || '';

  // HTTP 请求辅助
  const doc2xReq = (method, urlPath, body) => new Promise((resolve, reject) => {
    const u = new URL(urlPath, 'https://v2.doc2x.noedgeai.com');
    const opts = {
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method,
      headers: { 'Authorization': 'Bearer ' + DOC2X_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' }
    };
    const r = require('https').request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve({s:res.statusCode,d:JSON.parse(d)})}catch(e){resolve({s:res.statusCode,d})}}); });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });

  // Step 1: Preupload
  console.log(`[PDF] ${taskId}: Preupload`);
  const pre = await doc2xReq('POST', '/api/v2/parse/preupload', { model: 'v3-2026' });
  if (pre.d.code !== 'success') throw new Error('Preupload failed');
  const uid = pre.d.data.uid;

  // Step 2: Upload to OSS
  console.log(`[PDF] ${taskId}: Upload OSS`);
  const ossUrl = new URL(pre.d.data.url);
  await new Promise((resolve, reject) => {
    const opts = { hostname: ossUrl.hostname, port: 443, path: ossUrl.pathname + ossUrl.search, method: 'PUT',
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': pdfBuffer.length } };
    require('https').request(opts, res => resolve(res.statusCode)).on('error', reject).end(pdfBuffer);
  });

  // Step 3: Poll
  console.log(`[PDF] ${taskId}: Poll`);
  let result = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const s = await doc2xReq('GET', '/api/v2/parse/status?uid=' + uid);
    if (s.d.data && s.d.data.status === 'success') { result = s.d.data.result; break; }
    if (s.d.data && s.d.data.status === 'failed') throw new Error('Doc2X parsing failed');
  }
  if (!result || !result.pages) throw new Error('Doc2X timeout');

  // Step 4: 合并 Markdown + 下载图片
  console.log(`[PDF] ${taskId}: Download images`);
  // 保存逐页 markdown（前端页面截图对照用）
  const pageMd = (result.pages||[]).map(p => {
    if (typeof p.md === 'string' && p.md) return p.md;
    if (typeof p.get === 'function') return p.get('md') || '';
    return '';
  });
  let allMd = pageMd.join('\n\n');

  // 提取图片 URL 并下载
  const imgUrls = [...allMd.matchAll(/<img\s+src="(https:\/\/cdn\.noedgeai\.com\/[^"]+)"/g)].map(m => m[1]);
  for (let i = 0; i < imgUrls.length; i++) {
    const url = imgUrls[i];
    const u = new URL(url);
    const x = u.searchParams.get('x') || '0';
    const y = u.searchParams.get('y') || '0';
    const localName = `img_${i+1}_x${x}_y${y}.jpg`;
    const localPath = path.join(taskDir, localName);
    try {
      await new Promise((resolve, reject) => {
        require('https').get(url, resp => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            require('https').get(resp.headers.location, r2 => {
              const chunks = []; r2.on('data', c => chunks.push(c));
              r2.on('end', () => { fs.writeFileSync(localPath, Buffer.concat(chunks)); resolve(); });
            }).on('error', reject);
          } else {
            const chunks = []; resp.on('data', c => chunks.push(c));
            resp.on('end', () => { fs.writeFileSync(localPath, Buffer.concat(chunks)); resolve(); });
          }
        }).on('error', reject);
      });
      const webPath = `/uploads/doc2x_images/${taskId}/${localName}`;
      allMd = allMd.replace(url, webPath);
    } catch(e) { console.error(`[PDF] Image download failed: ${url}`); }
  }

  fs.writeFileSync(path.join(taskDir, 'raw.md'), allMd, 'utf8');

  // Step 5: 切题
  console.log(`[PDF] ${taskId}: Split questions`);
  let questions = splitQuestionsFromMd(allMd);
  if (questions.length === 0) throw new Error('No questions detected');

  // 解析答案并合并（仅在文档含答案区标记时才解析，避免学生版 PDF 误匹配）
  const hasAnswerSection = /(?:参考答案|【参考答案】|答案解析|试题解析|答案\s)(?![\s\S]{0,50}一、)/i.test(allMd);
  const answerMap = hasAnswerSection ? parseAnswersFromMd(allMd) : {};
  console.log(`[PDF] ${taskId}: Answer parsing ${hasAnswerSection ? 'enabled' : 'skipped (no answer section detected)'}`);
  questions.forEach(q => {
    const a = answerMap[q.number];
    if (a) { if (a.answer) q.answer = a.answer; if (a.analysis) q.analysis = a.analysis; }
  });

  // 应用默认属性
  questions.forEach(q => {
    q.difficulty = q.difficulty || defaults.difficulty;
    q.grade = defaults.grade;
    q.categoryId = defaults.categoryId;
    q.categoryName = defaults.categoryName;
    q.confirmed = false;
  });

  // Step 5.5: LLM 结构化解析（语义理解 OCR 文本，修正正则提取的错误）
  console.log(`[PDF] ${taskId}: LLM structured parsing...`);
  questions = await llmReparseQuestions(questions, taskId);

  // 收集所有图片 URL（供前端图片画廊使用），过滤空文件
  const allImages = [];
  const imgRe = /<img\s+src="(\/uploads\/doc2x_images\/[^"]+)"\/>/g;
  let im;
  while ((im = imgRe.exec(allMd)) !== null) {
    const imgUrl = im[1];
    // 检查图片文件是否存在且非空（Doc2X 有时返回 0 字节的失败提取）
    try {
      const fs = require('fs');
      const fullPath = __dirname + imgUrl;
      const stat = fs.statSync(fullPath);
      if (stat.size > 0) {
        allImages.push(imgUrl);
      } else {
        console.log(`[PDF] Skipping empty image: ${imgUrl} (0 bytes)`);
      }
    } catch (e) {
      // 文件不存在也跳过
      console.log(`[PDF] Skipping missing image: ${imgUrl}`);
    }
  }

  // 更新任务
  const tasks = readPdfTasks();
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.status = 'ready';
    task.totalPages = result.pages.length;
    task.questionCount = questions.length;
    task.questions = questions;
    task.allImages = allImages; // 全部配图列表
    task.pageMd = pageMd; // 逐页 markdown（页面截图对照用）
    writePdfTasks(tasks);
  }
  console.log(`[PDF] ${taskId}: Done — ${questions.length} questions`);
}

// ========== MinerU 本地解析核心（magic-pdf CLI） ==========
// 流程：PDF → MinerU 3.x CLI (pipeline backend) → 读取 full.md + 图片 → 切题 → LLM 结构化

// magic-pdf CLI 入口（兼容 MinerU 0.x 的 mineru.exe 和 magic-pdf 1.x 的 magic-pdf.exe）
// 跨用户兼容：90467（新电脑）/ Administrator（旧电脑）都能找到
const MINERU_CLI_CANDIDATES = [
  'C:\\Users\\90467\\.workbuddy\\binaries\\python\\envs\\mineru\\Scripts\\magic-pdf.exe',
  'C:\\Users\\90467\\.workbuddy\\binaries\\python\\envs\\mineru\\Scripts\\mineru.exe',
  'C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\mineru\\Scripts\\mineru.exe',
  'C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\mineru\\Scripts\\magic-pdf.exe',
];
const MINERU_CLI_PATH = MINERU_CLI_CANDIDATES.find(p => fs.existsSync(p)) || MINERU_CLI_CANDIDATES[0];

// xelatex（TeX Live）— 用于将 LaTeX 源码编译为 PDF（兼容 D 盘和 C 盘安装）
const XELATEX_CANDIDATES = [
  'D:\\texlive\\2026\\bin\\windows\\xelatex.exe',
  'C:\\texlive\\2026\\bin\\windows\\xelatex.exe',
  'C:\\texlive\\2025\\bin\\windows\\xelatex.exe',
  'C:\\texlive\\2024\\bin\\windows\\xelatex.exe',
  '/usr/bin/xelatex',
  '/usr/local/bin/xelatex',
];
const TECTONIC_CANDIDATES = [
  '/usr/local/bin/tectonic',
  '/usr/bin/tectonic',
];
const XELATEX_PATH = XELATEX_CANDIDATES.find(p => fs.existsSync(p)) || XELATEX_CANDIDATES[0];
const TECTONIC_PATH = TECTONIC_CANDIDATES.find(p => fs.existsSync(p)) || TECTONIC_CANDIDATES[0];
const USE_TECTONIC = !fs.existsSync(XELATEX_PATH) && fs.existsSync(TECTONIC_PATH);

if (fs.existsSync(XELATEX_PATH)) {
  console.log('[xelatex] 探测到路径:', XELATEX_PATH);
} else if (USE_TECTONIC) {
  console.log('[tectonic] 探测到路径:', TECTONIC_PATH, '(轻量模式)');
} else {
  console.warn('[LaTeX] 未找到 LaTeX 引擎，PDF 不可用，仅支持 ZIP 下载');
}

const AdmZip = require('adm-zip');

/**
 * 预处理上传的 PDF Buffer — 自动检测 ZIP 包或 LaTeX 源码并编译为真正 PDF
 * @returns {Promise<string|null>} 编译后的 PDF 路径，若无需预处理则返回 null
 */
async function preprocessPdfBuffer(pdfBuffer, taskDir, taskId) {
  // 检测是否为 ZIP 包（PK\x03\x04 开头）
  if (pdfBuffer.length >= 4 && pdfBuffer[0] === 0x50 && pdfBuffer[1] === 0x4B) {
    console.log(`[MinerU-Local] ${taskId}: 检测到 ZIP 压缩包，检查内容...`);
    try {
      const zip = new AdmZip(pdfBuffer);
      const entries = zip.getEntries();
      
      // 查找 .tex 文件
      const texEntries = entries.filter(e => e.entryName.endsWith('.tex') && !e.isDirectory);
      const imgEntries = entries.filter(e => {
        const n = e.entryName.toLowerCase();
        return (n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.pdf')) && !e.isDirectory;
      });
      
      if (texEntries.length > 0) {
        console.log(`[MinerU-Local] ${taskId}: ZIP 内含 .tex 文件 (${texEntries.length}) + ${imgEntries.length} 张图片，开始编译...`);
        const extractDir = path.join(taskDir, 'latex_source');
        zip.extractAllTo(extractDir, true);
        
        // 编译 .tex 为 PDF
        const texFileName = texEntries[0].entryName;
        const texPath = path.join(extractDir, texFileName);
        const outputPdfPath = path.join(taskDir, 'compiled.pdf');
        await compileTexToPdf(texPath, extractDir, outputPdfPath, taskId);
        
        // 把图片也复制到 taskDir 根目录（方便后续 web 路径访问）
        for (const img of imgEntries) {
          const imgName = path.basename(img.entryName);
          const srcPath = path.join(extractDir, img.entryName);
          const dstPath = path.join(taskDir, imgName);
          if (fs.existsSync(srcPath) && !fs.existsSync(dstPath)) {
            fs.copyFileSync(srcPath, dstPath);
          }
        }
        
        return outputPdfPath;
      }
    } catch (zipErr) {
      console.error(`[MinerU-Local] ${taskId}: ZIP 解析失败:`, zipErr.message);
      // 不是有效的 ZIP 或无法解压，继续尝试作为 PDF 处理
    }
  }
  
  // 检测是否为纯 LaTeX 文件（以 % 或 \documentclass 开头）
  const textStart = pdfBuffer.slice(0, 500).toString('utf-8').trim();
  if (textStart.includes('\\documentclass') || textStart.startsWith('%') && textStart.includes('\\documentclass')) {
    console.log(`[MinerU-Local] ${taskId}: 检测到纯 LaTeX 文件，开始编译...`);
    const texPath = path.join(taskDir, 'source.tex');
    fs.writeFileSync(texPath, pdfBuffer);
    const outputPdfPath = path.join(taskDir, 'compiled.pdf');
    await compileTexToPdf(texPath, taskDir, outputPdfPath, taskId);
    return outputPdfPath;
  }
  
  // 真正的 PDF 或其他格式
  return null;
}

/**
 * 用 xelatex 编译 .tex 文件为 PDF
 */
async function compileTexToPdf(texPath, workDir, outputPdfPath, taskId) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  
  const texName = path.basename(texPath);
  const pdfName = texName.replace(/\.tex$/, '.pdf');
  const expectedPdf = path.join(workDir, pdfName);
  
  console.log(`[MinerU-Local] ${taskId}: 运行 xelatex 编译 ${texName}...`);
  
  try {
    // 编译两次（解决交叉引用、目录等）
    for (let pass = 0; pass < 2; pass++) {
      const { stderr } = await execFileAsync(XELATEX_PATH, [
        '-interaction=nonstopmode',
        `-output-directory=${workDir}`,
        texName,
      ], {
        cwd: workDir,
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stderr && stderr.length > 50) {
        console.log(`[MinerU-Local] ${taskId}: xelatex 第${pass+1}遍: ${stderr.substring(0, 300)}`);
      }
    }
    
    if (fs.existsSync(expectedPdf)) {
      fs.copyFileSync(expectedPdf, outputPdfPath);
      const pdfSize = (fs.statSync(outputPdfPath).size / 1024).toFixed(1);
      console.log(`[MinerU-Local] ${taskId}: ✅ LaTeX 编译成功 → ${pdfSize} KB PDF`);
      return outputPdfPath;
    } else {
      // 检查 .log 文件获取详细错误
      const logPath = expectedPdf.replace(/\.pdf$/, '.log');
      const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8').substring(0, 2000) : '';
      const errLines = logContent.split('\n').filter(l => l.includes('!'));
      console.error(`[MinerU-Local] ${taskId}: xelatex 编译失败，错误行:`, errLines.slice(0, 5));
      throw new Error(`xelatex 编译失败，未生成 PDF（检查 ${logPath}）`);
    }
  } catch (err) {
    if (err.message.includes('xelatex 编译失败')) throw err;
    console.error(`[MinerU-Local] ${taskId}: xelatex 执行异常:`, err.message);
    throw new Error(`LaTeX 编译失败: ${err.message}`);
  }
}

// ========== PaddleOCR-VL（已移除） ==========
// 如需恢复，取消下面注释并取消函数体注释
//      → 等待子进程完成 → 读取 output/*.md + images → 切题 → 入库
async function processPdfWithPaddleOCRVL(taskId, pdfBuffer, taskDir, defaults) {
  // 0. 前置检查：venv python 和脚本存在
  if (!fs.existsSync(PADDLE_VL_VENV)) {
    throw new Error(`PaddleOCR-VL venv python 不存在: ${PADDLE_VL_VENV}\n请先按 D:/PaddleOCR-VL 部署文档安装`);
  }
  if (!fs.existsSync(PADDLE_VL_SCRIPT)) {
    throw new Error(`PaddleOCR-VL 解析脚本不存在: ${PADDLE_VL_SCRIPT}`);
  }

  // 1. 写入 PDF 到任务目录
  const pdfPath = path.join(taskDir, 'input.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);
  console.log(`[PaddleOCR-VL] ${taskId}: 待解析 PDF (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);

  // 2. 调用 PaddleOCR-VL 子进程
  console.log(`[PaddleOCR-VL] ${taskId}: 启动 PaddleOCR-VL (CPU 模式，预计 5-30 分钟)...`);
  const tks1 = readPdfTasks();
  const t1 = tks1.find(x => x.id === taskId);
  if (t1) { t1.processingNote = 'PaddleOCR-VL CPU 解析中，首次会加载模型请耐心等待...'; writePdfTasks(tks1); }

  const startTime = Date.now();
  const { spawn } = require('child_process');

  await new Promise((resolve, reject) => {
    const child = spawn(PADDLE_VL_VENV, [PADDLE_VL_SCRIPT, pdfPath], {
      cwd: 'D:\\PaddleOCR-VL', // 在 PaddleOCR-VL 目录运行（避免路径问题）
      env: {
        ...process.env,
        // 跳过模型源连通性检查（使用本地缓存）
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
        // 强制 CPU 模式
        CUDA_VISIBLE_DEVICES: '',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      const s = d.toString();
      stdout += s;
      // 实时打印关键进度
      const lines = s.split('\n').filter(l => l.trim());
      for (const line of lines.slice(-3)) {
        console.log(`[PaddleOCR-VL] ${taskId}: ${line.trim()}`);
      }
    });
    child.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      // 错误也打印前几行
      const lines = s.split('\n').filter(l => l.trim());
      for (const line of lines.slice(-5)) {
        console.error(`[PaddleOCR-VL-stderr] ${taskId}: ${line.trim()}`);
      }
    });

    // 超时控制
    const timer = setTimeout(() => {
      console.error(`[PaddleOCR-VL] ${taskId}: 超时 ${PADDLE_VL_TIMEOUT_MS/60000} 分钟，强制终止`);
      try { child.kill('SIGKILL'); } catch(e) {}
      reject(new Error(`PaddleOCR-VL 解析超时（${PADDLE_VL_TIMEOUT_MS/60000} 分钟）`));
    }, PADDLE_VL_TIMEOUT_MS);

    child.on('close', code => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`[PaddleOCR-VL] ${taskId}: ✅ 子进程完成 (${elapsed}s)`);
        resolve();
      } else {
        console.error(`[PaddleOCR-VL] ${taskId}: ❌ 子进程退出码 ${code} (${elapsed}s)`);
        if (stderr) console.error(`[PaddleOCR-VL] stderr 末段:`, stderr.substring(stderr.length - 1500));
        reject(new Error(`PaddleOCR-VL 解析失败，退出码 ${code}。请查看服务端日志。`));
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      console.error(`[PaddleOCR-VL] ${taskId}: 启动失败:`, err.message);
      reject(new Error(`PaddleOCR-VL 启动失败: ${err.message}`));
    });
  });

  // 3. 读取输出：PaddleOCR-VL 默认输出到 D:/PaddleOCR-VL/output/
  //    ⚠️ output/ 是共享目录，必须只取本次运行产生的新文件（用时间戳过滤）
  const paddleOutDir = 'D:\\PaddleOCR-VL\\output';
  if (!fs.existsSync(paddleOutDir)) {
    throw new Error(`PaddleOCR-VL 输出目录不存在: ${paddleOutDir}`);
  }

  // 只读取子进程运行期间新产生的 .md 文件
  const beforeTime = startTime; // startTime 是 spawn 之前记录的 Date.now()
  const allMdFiles = fs.readdirSync(paddleOutDir).filter(f => f.endsWith('.md') && !f.startsWith('~'));
  const newMdFiles = allMdFiles.filter(f => {
    try {
      const stat = fs.statSync(path.join(paddleOutDir, f));
      return stat.mtimeMs >= beforeTime - 1000; // 允许1秒误差
    } catch(e) { return false; }
  });

  if (newMdFiles.length === 0) {
    // 兜底：如果没有新文件，尝试按文件名模式匹配 input*.md（本次 PDF 固定命名为 input.pdf）
    const fallbackFiles = allMdFiles.filter(f => /^input(_\d+)?\.md$/.test(f));
    if (fallbackFiles.length > 0) {
      console.warn(`[PaddleOCR-VL] ${taskId}: 时间戳未匹配到新文件，回退按文件名匹配: ${fallbackFiles.join(', ')}`);
      newMdFiles.push(...fallbackFiles);
    } else {
      throw new Error('PaddleOCR-VL 输出目录中没有本次解析产生的 .md 文件（旧文件已自动过滤）');
    }
  }

  // 合并本次产生的 .md（按文件名排序）
  newMdFiles.sort();
  let allMd = '';
  for (const mdFile of newMdFiles) {
    const mdPath = path.join(paddleOutDir, mdFile);
    const content = fs.readFileSync(mdPath, 'utf8');
    allMd += `\n\n<!-- page: ${mdFile} -->\n\n` + content;
  }
  console.log(`[PaddleOCR-VL] ${taskId}: 读取 ${newMdFiles.length} 个 md 文件（共 ${allMdFiles.length} 个文件，过滤掉 ${allMdFiles.length - newMdFiles.length} 个旧文件），共 ${allMd.length} 字符`);

  // 4. 图片：PaddleOCR-VL 输出到 output/imgs/
  const paddleImgDir = path.join(paddleOutDir, 'imgs');
  let imagesDir = '';
  if (fs.existsSync(paddleImgDir) && fs.statSync(paddleImgDir).isDirectory()) {
    imagesDir = paddleImgDir;
    console.log(`[PaddleOCR-VL] ${taskId}: 找到图片目录 ${paddleImgDir}`);
  } else {
    console.log(`[PaddleOCR-VL] ${taskId}: ⚠️ 未找到 imgs/ 目录，将无图片`);
  }

  // 5. 调用统一的"切题 + 提取选项"逻辑（复用 MinerU Local 的实现）
  //    通过 processQuestionsFromMarkdown 完成：图片映射 + 切题 + 选区入库
  const imgMapping = processImagesFromDir(imagesDir, taskDir, beforeTime);
  const imageCount = Object.keys(imgMapping).length;
  console.log(`[PaddleOCR-VL] ${taskId}: 已映射 ${imageCount} 张图片`);

  await processQuestionsFromMarkdown(
    taskId, allMd, imgMapping, taskDir, defaults,
    `[PaddleOCR-VL]`
  );
}


// ========= Qwen 多模态 LaTeX 识别核心 =========
// 流程：PDF → 写入临时文件 → 调用 qwen_vlm_bridge.py → 获 JSON 结果
//     → 解析 questions_latex / answers / images → 切题 → 入库
async function processPdfWithQwenVLM(taskId, pdfBuffer, taskDir, defaults) {
  // 0. 前置检查：Python 和桥接脚本存在
  if (!fs.existsSync(QWEN_VLM_PYTHON)) {
    throw new Error(`Qwen VLM Python 不存在: ${QWEN_VLM_PYTHON}\n请确认 Python 环境已安装 PyMuPDF、dashscope、pillow`);
  }
  if (!fs.existsSync(QWEN_VLM_SCRIPT)) {
    throw new Error(`Qwen VLM 桥接脚本不存在: ${QWEN_VLM_SCRIPT}`);
  }

  // 1. 写入 PDF 到任务目录
  const pdfPath = path.join(taskDir, 'input.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);
  console.log(`[QwenVLM] ${taskId}: 待解析 PDF (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);

  // 2. 调用 Qwen VLM 子进程
  console.log(`[QwenVLM] ${taskId}: 启动 Qwen VLM 识别（预计 2-10 分钟）...`);
  const tks1 = readPdfTasks();
  const t1 = tks1.find(x => x.id === taskId);
  if (t1) { t1.processingNote = 'Qwen 多模态识别中，正在调用 DashScope API...'; writePdfTasks(tks1); }

  const startTime = Date.now();
  const { spawn } = require('child_process');

  const result = await new Promise((resolve, reject) => {
    const child = spawn(QWEN_VLM_PYTHON, [QWEN_VLM_SCRIPT, pdfPath, taskDir], {
      cwd: 'D:\\math-website',
      env: {
        ...process.env,
        QWEN3P5_PLUS_API_KEY: process.env.QWEN3P5_PLUS_API_KEY || '',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      const s = d.toString();
      stdout += s;
      // 实时打印进度
      const lines = s.trim().split('\n');
      for (const line of lines.slice(-2)) {
        if (line.trim()) console.log(`[QwenVLM-stdout] ${taskId}: ${line.trim()}`);
      }
    });
    child.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      const lines = s.trim().split('\n');
      for (const line of lines.slice(-3)) {
        if (line.trim()) console.error(`[QwenVLM-stderr] ${taskId}: ${line.trim()}`);
      }
    });

    // 超时控制
    const timer = setTimeout(() => {
      console.error(`[QwenVLM] ${taskId}: 超时 ${QWEN_VLM_TIMEOUT_MS / 60000} 分钟，强制终止`);
      try { child.kill('SIGKILL'); } catch(e) {}
      reject(new Error(`Qwen VLM 识别超时（${QWEN_VLM_TIMEOUT_MS / 60000} 分钟）`));
    }, QWEN_VLM_TIMEOUT_MS);

    child.on('close', code => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`[QwenVLM] ${taskId}: ✅ 子进程完成 (${elapsed}s)`);
        try {
          const json = JSON.parse(stdout);
          resolve(json);
        } catch (e) {
          // stdout 可能不是纯 JSON（有调试日志混在里面）
          // 尝试提取最后一个 JSON 对象
          const jsonMatch = stdout.match(/\{[\s\S]*\}$/m);
          if (jsonMatch) {
            try {
              resolve(JSON.parse(jsonMatch[0]));
              return;
            } catch(e2) {}
          }
          reject(new Error(`Qwen VLM 输出解析失败：${e.message}\nstdout 末段：${stdout.substring(stdout.length - 500)}`));
        }
      } else {
        console.error(`[QwenVLM] ${taskId}: ❌ 子进程退出码 ${code} (${elapsed}s)`);
        if (stderr) console.error(`[QwenVLM] stderr 末段:`, stderr.substring(stderr.length - 1500));
        reject(new Error(`Qwen VLM 识别失败，退出码 ${code}。请查看服务端日志。`));
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      console.error(`[QwenVLM] ${taskId}: 启动失败:`, err.message);
      reject(new Error(`Qwen VLM 启动失败: ${err.message}`));
    });
  });

  // 3. 解析结果
  console.log(`[QwenVLM] ${taskId}: 解析结果...`);
  let questionsLatex = result.questions_latex || '';
  const answers = result.answers || {};
  const images = result.images || [];  // PDF 嵌入图片路径列表
  const pageImages = result.page_images || [];  // 逐页截图路径列表

  console.log(`[QwenVLM] ${taskId}: 题目 LaTeX ${questionsLatex.length} 字符, 答案 ${Object.keys(answers).length} 项, 图片 ${images.length} 张`);

  // 3.5 兜底：去除 Qwen 偶尔输出的 \nonumber 命令（否则切题正则无法匹配题号）
  questionsLatex = questionsLatex.replace(/\\nonumber\s*/g, '');

  // 4. 将 LaTeX 题目转为 Markdown（便于现有切题逻辑处理）
  //    Qwen 输出格式：\begin{problem} ... \end{problem}
  //    转为 Markdown：每个 problem 作为一个题目块
  let mdContent = '';
  const problemRe = /\\begin\{problem\}([\s\S]*?)\\end\{problem\}/g;
  let match;
  let probCount = 0;
  while ((match = problemRe.exec(questionsLatex)) !== null) {
    probCount++;
    const probContent = match[1].trim();
    mdContent += `## 题目 ${probCount}\n\n${probContent}\n\n`;
  }
  if (!mdContent) {
    //  fallback：直接用 LaTeX（可能 Qwen 输出格式不同）
    mdContent = `## 题目 1\n\n${questionsLatex}\n\n`;
  }
  console.log(`[QwenVLM] ${taskId}: 识别出 ${probCount} 个题目块，转为 Markdown ${mdContent.length} 字符`);

  // 5. 处理图片：将 PDF 嵌入图片复制到 taskDir/images/
  let imagesDir = path.join(taskDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const imgMapping = {};
  for (const imgPath of images) {
    if (fs.existsSync(imgPath)) {
      const imgName = path.basename(imgPath);
      const destPath = path.join(imagesDir, imgName);
      fs.copyFileSync(imgPath, destPath);
      const webPath = `/uploads/doc2x_images/${path.basename(taskDir)}/images/${imgName}`;
      imgMapping[imgName] = webPath;
    }
  }
  console.log(`[QwenVLM] ${taskId}: 已复制 ${Object.keys(imgMapping).length} 张图片到 ${imagesDir}`);

  // 6. 答案处理（如果有）—— 自行解析 \begin{solution} 块，构建 answerMap
  let qwenAnswerMap = {};
  if (answers.raw) {
    console.log(`[QwenVLM] ${taskId}: 答案已提取（${answers.raw.length} 字符），开始解析 solution 块`);
    // 把答案写入 taskDir/answers.md 留底
    fs.writeFileSync(path.join(taskDir, 'answers.md'), answers.raw, 'utf8');

    // 解析 \begin{solution} ... \end{solution} 块
    const solRe = /\\begin\{solution\}([\s\S]*?)\\end\{solution\}/g;
    let solMatch;
    let solCount = 0;
    while ((solMatch = solRe.exec(answers.raw)) !== null) {
      const solContent = solMatch[1].trim();
      // 从内容行首提取题号：1. / 1、 / 1．
      const numMatch = solContent.match(/^(\d{1,2})[\.、．]/);
      if (numMatch) {
        const num = parseInt(numMatch[1]);
        // 去掉行首的题号，保留答案+详解全文
        const answerText = solContent.replace(/^\d{1,2}[\.、．]\s*/, '').trim();
        qwenAnswerMap[num] = {
          answer: '',           // 解答题没有简短答案
          analysis: answerText,  // 整段作为详解
        };
        solCount++;
      }
    }
    console.log(`[QwenVLM] ${taskId}: 解析出 ${solCount} 个 solution 块 -> answerMap keys: [${Object.keys(qwenAnswerMap).join(',')}]`);
  }

  // 7. 调用统一的"切题 + 替换图片 + LLM 结构化 + 入库"流程
  await processQuestionsFromMarkdown(
    taskId, mdContent, imgMapping, taskDir, defaults,
    '[QwenVLM]', qwenAnswerMap
  );
}

async function processPdfWithMinerULocal(taskId, pdfBuffer, taskDir, defaults) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  // ===== Step 0: 保存原始文件 + 预处理（检测 ZIP/LaTeX 并自动编译） =====
  const originalPdfPath = path.join(taskDir, 'input.pdf');
  // 如果之前没保存过原始文件（编译场景下可能跳过）
  if (!fs.existsSync(originalPdfPath)) {
    fs.writeFileSync(originalPdfPath, pdfBuffer);
  }
  
  let pdfPath = originalPdfPath;
  let processingNote = '';
  
  try {
    const compiledPdf = await preprocessPdfBuffer(pdfBuffer, taskDir, taskId);
    if (compiledPdf) {
      pdfPath = compiledPdf;
      processingNote = 'LaTeX 源码已自动编译为 PDF';
      console.log(`[MinerU-Local] ${taskId}: 使用编译后的 PDF: ${compiledPdf}`);
    }
  } catch (preErr) {
    console.error(`[MinerU-Local] ${taskId}: 预处理失败:`, preErr.message);
    throw preErr; // 编译失败不可恢复，直接抛出
  }
  
  // 更新任务状态（通知前端处理过程）
  if (processingNote) {
    const tks = readPdfTasks();
    const t = tks.find(x => x.id === taskId);
    if (t) { t.processingNote = processingNote; writePdfTasks(tks); }
  }
  
  console.log(`[MinerU-Local] ${taskId}: 待解析 PDF (${(fs.statSync(pdfPath).size / 1024).toFixed(1)} KB)`);

  // ===== Step 2: 调用 magic-pdf 解析 =====
  const parseOutputDir = path.join(taskDir, 'mineru_output');
  fs.mkdirSync(parseOutputDir, { recursive: true });
  console.log(`[MinerU-Local] ${taskId}: 开始 MinerU 3.x 解析 (modelscope + VLM hybrid)...`);
  
  try {
    const startTime = Date.now();
    const { stdout, stderr } = await execFileAsync(MINERU_CLI_PATH, [
      '-p', pdfPath,
      '-o', parseOutputDir,
      '-m', 'auto',
    ], {
      timeout: 600000,  // 10 分钟超时（首次需加载 VLM 模型）
      maxBuffer: 10 * 1024 * 1024, // 10MB stdout
      env: {
        ...process.env,
        // magic-pdf 1.x 配置文件：~/magic-pdf.json（已创建，models-dir=D:\models\MinerU\models）
        // 注：magic-pdf 1.x 不再用 MINERU_MODEL_SOURCE 环境变量，统一读 magic-pdf.json
        // 模型来源（ModelScope 缓存）由 ~/.cache/modelscope 自动管理
        HOME: 'C:\\Users\\90467',
        USERPROFILE: 'C:\\Users\\90467',
      }
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[MinerU-Local] ${taskId}: MinerU 完成 (${elapsed}s)`);
    if (stderr) console.log(`[MinerU-Local] stderr:`, stderr.substring(0, 500));
  } catch (err) {
    console.error(`[MinerU-Local] ${taskId}: MinerU 执行失败:`, err.message);
    console.error(`[MinerU-Local] stderr:`, err.stderr?.substring(0, 1000) || 'N/A');
    throw new Error(`MinerU 本地解析失败: ${err.message}`);
  }

  // ===== Step 3: 查找并读取 MinerU 输出 =====
  // magic-pdf 1.x 输出结构: parseOutputDir/{pdf_name}/auto/input.md
  // MinerU 3.x 输出结构: parseOutputDir/{pdf_name}/hybrid_auto/{pdf_name}.md
  // 旧版 MinerU/2.x: parseOutputDir/{pdf_name}/full.md
  let allMd = '';
  let imagesDir = '';
  let contentJson = null;

  const subDirs = fs.readdirSync(parseOutputDir).filter(d => {
    const full = path.join(parseOutputDir, d);
    return fs.statSync(full).isDirectory();
  });

  for (const subDir of subDirs) {
    const subPath = path.join(parseOutputDir, subDir);

    // magic-pdf 1.x 新格式: 查找 auto/input.md 或 auto/*.md
    const autoDir = path.join(subPath, 'auto');
    if (fs.existsSync(autoDir) && fs.statSync(autoDir).isDirectory()) {
      const autoFiles = fs.readdirSync(autoDir).filter(f => f.endsWith('.md'));
      if (autoFiles.length > 0) {
        const mdPath = path.join(autoDir, autoFiles[0]);
        allMd = fs.readFileSync(mdPath, 'utf8');
        imagesDir = path.join(autoDir, 'images');
        // 尝试读取结构化 JSON（magic-pdf 1.x 格式）
        const jsonCandidates = [
          path.join(autoDir, 'input_content_list.json'),
          path.join(autoDir, `${subDir}_content_list_v2.json`),
        ];
        for (const jp of jsonCandidates) {
          if (fs.existsSync(jp)) {
            try { contentJson = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch(e) { /* ignore */ }
            if (contentJson) break;
          }
        }
        console.log(`[MinerU-Local] ${taskId}: magic-pdf 1.x 输出 — ${autoFiles[0]} (${allMd.length} 字符), content_list: ${contentJson ? 'found' : 'N/A'}`);
        break;
      }
    }

    // MinerU 3.x: 查找 hybrid_auto/{pdf_name}.md
    const hybridDir = path.join(subPath, 'hybrid_auto');
    if (!allMd && fs.existsSync(hybridDir) && fs.statSync(hybridDir).isDirectory()) {
      const files = fs.readdirSync(hybridDir).filter(f => f.endsWith('.md'));
      if (files.length > 0) {
        const mdPath = path.join(hybridDir, files[0]);
        allMd = fs.readFileSync(mdPath, 'utf8');
        imagesDir = path.join(hybridDir, 'images');
        // 尝试读取结构化 JSON
        const jsonPath = path.join(hybridDir, `${subDir}_content_list_v2.json`);
        if (fs.existsSync(jsonPath)) {
          try {
            contentJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          } catch(e) { /* ignore */ }
        }
        console.log(`[MinerU-Local] ${taskId}: MinerU 3.x 输出 — ${files[0]} (${allMd.length} 字符), content_list: ${contentJson ? 'found' : 'N/A'}`);
        break;
      }
    }

    // 旧版 MinerU: 查找 full.md
    const oldMdPath = path.join(subPath, 'full.md');
    if (!allMd && fs.existsSync(oldMdPath)) {
      allMd = fs.readFileSync(oldMdPath, 'utf8');
      imagesDir = path.join(subPath, 'images');
      console.log(`[MinerU-Local] ${taskId}: 旧版输出 full.md (${allMd.length} 字符)`);
      break;
    }
  }

  if (!allMd) throw new Error('MinerU 输出中未找到 .md 文件，请检查模型是否已下载');

  // ===== Step 4: 处理图片 =====
  const imgMapping = processImagesFromDir(imagesDir, taskDir);
  const imageCount = Object.keys(imgMapping).length;
  console.log(`[MinerU-Local] ${taskId}: 处理了 ${imageCount} 张图片`);

  // ===== Step 5~11: 切题 + LLM + 入库（复用 PaddleOCR-VL 也用的统一流程）=====
  await processQuestionsFromMarkdown(
    taskId, allMd, imgMapping, taskDir, defaults,
    '[MinerU-Local]'
  );
}

/**
 * 把源图片目录里的图片复制到 taskDir，并返回映射 {原文件名: web路径}
 * 多个 PDF 解析引擎（MinerU Local / PaddleOCR-VL）共用
 */
function processImagesFromDir(imagesDir, taskDir, sinceTimestamp) {
  const imgMapping = {};
  if (!imagesDir || !fs.existsSync(imagesDir)) return imgMapping;
  const taskId = path.basename(taskDir);
  const imgFiles = fs.readdirSync(imagesDir)
    .filter(f => /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(f));
  let idx = 0;
  let skippedOld = 0;
  for (const imgFile of imgFiles) {
    const srcPath = path.join(imagesDir, imgFile);
    if (fs.statSync(srcPath).size === 0) continue;
    // 时间戳过滤：只取本次运行产生的新图片
    if (sinceTimestamp) {
      try {
        if (fs.statSync(srcPath).mtimeMs < sinceTimestamp - 1000) { skippedOld++; continue; }
      } catch(e) { continue; }
    }
    idx++;
    const ext = path.extname(imgFile) || '.jpg';
    const localName = `img_${idx}${ext}`;
    const destPath = path.join(taskDir, localName);
    const webPath = `/uploads/doc2x_images/${taskId}/${localName}`;
    fs.copyFileSync(srcPath, destPath);
    imgMapping[imgFile] = webPath;
  }
  if (skippedOld > 0) console.log(`[processImages] 跳过 ${skippedOld} 张旧图片`);
  return imgMapping;
}

/**
 * 统一的"切题 + 替换图片 + LLM 解析 + 入库"流程
 * MinerU Local 和 PaddleOCR-VL 共用，节省重复代码
 */
async function processQuestionsFromMarkdown(taskId, allMd, imgMapping, taskDir, defaults, logPrefix = '[PDF-Batch]', externalAnswerMap = null) {
  // ===== 替换 Markdown 中的图片引用 =====
  let replacedImages = 0;
  for (const [origFile, webPath] of Object.entries(imgMapping)) {
    const escaped = escapeRegex(origFile);
    const patterns = [
      new RegExp(`!\\[[^\\]]*\\]\\([^)]*${escaped}\\)`, 'g'),
      new RegExp(`!\\[[^\\]]*\\]\\(\\s*${escaped}\\s*\\)`, 'g'),
    ];
    for (const p of patterns) {
      const matches = allMd.match(p);
      if (matches) {
        allMd = allMd.replace(p, `(<img src="${webPath}"/>)`);
        replacedImages += matches.length;
      }
    }
  }
  console.log(`${logPrefix} ${taskId}: 替换了 ${replacedImages} 个图片引用`);

  // 保存处理后的 MD
  fs.writeFileSync(path.join(taskDir, 'raw.md'), allMd, 'utf8');

  // ===== 切分题目 =====
  console.log(`${logPrefix} ${taskId}: 切分题目...`);
  let questions = splitQuestionsFromMd(allMd);
  if (questions.length === 0) {
    console.warn(`${logPrefix} ${taskId}: splitQuestionsFromMd 切题失败，尝试逐行切分`);
    questions = fallbackSplitMd(allMd);
  }
  if (questions.length === 0) throw new Error('从 PDF 输出中未检测到题目');

  // ===== 解析答案 =====
  let answerMap;
  if (externalAnswerMap && Object.keys(externalAnswerMap).length > 0) {
    // Qwen VLM 等引擎已自行解析答案，直接使用
    answerMap = externalAnswerMap;
    console.log(`${logPrefix} ${taskId}: Answer parsing (external map, ${Object.keys(answerMap).length} entries)`);
  } else {
    const hasAnswerSection = /(?:参考答案|【参考答案】|答案解析|试题解析|答案\s)(?![\s\S]{0,50}一、)/i.test(allMd);
    answerMap = hasAnswerSection ? parseAnswersFromMd(allMd) : {};
    console.log(`${logPrefix} ${taskId}: Answer parsing ${hasAnswerSection ? 'enabled' : 'skipped'}`);
  }
  questions.forEach(q => {
    const a = answerMap[q.number];
    if (a) { if (a.answer) q.answer = a.answer; if (a.analysis) q.analysis = a.analysis; }
  });

  // ===== 应用默认属性 =====
  questions.forEach(q => {
    q.difficulty = q.difficulty || defaults.difficulty;
    q.grade = defaults.grade;
    q.categoryId = defaults.categoryId;
    q.categoryName = defaults.categoryName;
    q.confirmed = false;
  });

  // ===== LLM 结构化解析 =====
  console.log(`${logPrefix} ${taskId}: LLM structured parsing...`);
  try {
    questions = await llmReparseQuestions(questions, taskId);
  } catch (e) {
    console.warn(`${logPrefix} ${taskId}: LLM 解析失败 (${e.message})，使用原始切分结果`);
  }

  // ===== 收集所有有效图片 =====
  const allImages = [];
  for (const wp of Object.values(imgMapping)) {
    try {
      const fullPath = path.join(__dirname, wp);
      if (fs.statSync(fullPath).size > 0) allImages.push(wp);
    } catch(e) {}
  }

  // ===== 更新任务 =====
  const tasks = readPdfTasks();
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.status = 'ready';
    task.totalPages = 1;
    task.questionCount = questions.length;
    task.questions = questions;
    task.allImages = allImages;
    task.pageMd = [allMd];
    writePdfTasks(tasks);
  }
  console.log(`${logPrefix} ${taskId}: Done — ${questions.length} questions, ${allImages.length} images`);
}

/** 
 * 兜底切题：按 markdown 标题（## 1. 或 ## 1、）切分
 * 当 splitQuestionsFromMd 无法识别题目时使用
 */
function fallbackSplitMd(allMd) {
  const questions = [];
  
  // 按 ## N 标题切分
  const sections = allMd.split(/\n(?=##\s*\d+[\s\.、．])/);
  
  for (const section of sections) {
    const match = section.match(/^##\s*(\d+)[\s\.、．]/);
    if (!match) continue;
    
    const number = parseInt(match[1]);
    const body = section.replace(/^##\s*\d+[\s\.、．][^\n]*\n?/, '').trim();
    if (!body) continue;
    
    // 检测题型
    let type = '简答题';
    const text80 = body.substring(0, 80);
    if (/[A-D][\.．]\s*\S/.test(text80)) type = '单选题';
    
    questions.push({
      number, type,
      content: body,
      options: [],
      answer: '',
      analysis: '',
      difficulty: '',
      grade: '',
      categoryId: '',
      categoryName: '',
      confirmed: false
    });
  }
  
  return questions;
}

// ========== MinerU v4 精准解析核心（Hybrid: Agent上传 + v4解析） ==========
// 流程：Agent轻量版上传本地PDF→获file_url → 提交v4精准解析 → 下载ZIP解压得MD+图片

const MINERU_BASE = 'https://mineru.net';
// ⚠️ Token 需在 MinerU 后台 API管理页面创建：https://mineru.net/apiManage
// Token 存放在项目根目录 .env 文件中（不入 git），通过 dotenv 自动加载
const MINERU_TOKEN = process.env.MINERU_TOKEN || '';

async function processPdfWithMinerU(taskId, pdfBuffer, taskDir, defaults) {
  if (!MINERU_TOKEN) throw new Error('未配置 MINERU_TOKEN 环境变量，请在 MinerU 后台 API管理页面创建 Token');

  const https = require('https');
  const http = require('http');
  const AdmZip = require('adm-zip');

  // --- HTTP 辅助函数 ---
  const mineruReq = (method, apiPath, opts = {}) => new Promise((resolve, reject) => {
    const u = new URL(apiPath, MINERU_BASE);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const reqOpts = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { ...opts.headers },
      timeout: opts.timeout || 30000
    };
    // 默认带 Bearer Token（上传 OSS 不带）
    if (!opts.noAuth) {
      reqOpts.headers['Authorization'] = 'Bearer ' + MINERU_TOKEN;
    }
    const req = mod.request(reqOpts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (opts.body !== undefined) {
      const bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      req.setHeader('Content-Length', Buffer.byteLength(bodyStr));
      req.write(bodyStr);
    }
    req.end();
  });

  // PUT 文件上传（用于 Agent 上传和 ZIP 下载）
  const putFile = (url, buffer, extraHeaders = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const reqOpts = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method: 'PUT',
      headers: { 'Content-Length': buffer.length, ...extraHeaders },
      timeout: 120000
    };
    const req = mod.request(reqOpts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Upload timeout')); });
    req.end(buffer);
  });

  // GET 下载文件
  const downloadFile = (url) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });

  const pdfName = `upload_${taskId}.pdf`;

  // ===== Step 1: Agent 轻量版上传 PDF → 获取 file_url =====
  console.log(`[MinerU] ${taskId}: Step1 - 上传 PDF (Agent)...`);
  const uploadRes = await mineruReq('POST', '/api/v1/agent/parse/file', {
    headers: { 'Content-Type': 'application/json' },
    body: {
      file_name: pdfName,
      language: 'ch',
      enable_formula: true,
      enable_table: true,
      is_ocr: false
    }
  });
  console.log(`[MinerU] Step1 响应:`, JSON.stringify(uploadRes.body).substring(0, 300));

  if (uploadRes.body.code !== 0) {
    throw new Error('MinerU Agent 上传失败: ' + (uploadRes.body.msg || JSON.stringify(uploadRes.body)));
  }
  const agentFileUrl = uploadRes.body.data.file_url;
  const agentTaskId = uploadRes.body.data.task_id;
  console.log(`[MinerU] ${taskId}: 获得 file_url: ${agentFileUrl?.substring(0, 80)}...`);

  // ===== Step 2: PUT 文件到 OSS =====
  console.log(`[MinerU] ${taskId}: Step2 - PUT 文件到 OSS (${pdfBuffer.length} bytes)...`);
  const putRes = await putFile(agentFileUrl, pdfBuffer);
  console.log(`[MinerU] ${taskId}: OSS PUT 状态码 = ${putRes.status}`);
  if (putRes.status !== 200 && putRes.status !== 204 && putRes.status !== 201) {
    throw new Error(`MinerU OSS 上传失败 (HTTP ${putRes.status}): ${putRes.body?.substring(0, 200)}`);
  }
  console.log(`[MinerU] ${taskId}: OSS 上传成功`);

  // ===== Step 3: 提交 v4 精准解析任务（用 Agent 的 file_url） =====
  console.log(`[MinerU] ${taskId}: Step3 - 提交 v4 精准解析任务...`);
  const extractRes = await mineruReq('POST', '/api/v4/extract/task', {
    headers: { 'Content-Type': 'application/json' },
    body: {
      url: agentFileUrl,
      model_version: 'vlm',
      enable_formula: true,
      enable_table: true,
      language: 'ch'
    }
  });
  console.log(`[MinerU] Step3 响应:`, JSON.stringify(extractRes.body).substring(0, 300));

  if (extractRes.body.code !== 0) {
    throw new Error('MinerU v4 任务创建失败: ' + (extractRes.body.msg || JSON.stringify(extractRes.body)));
  }
  const v4TaskId = extractRes.body.data.task_id;
  console.log(`[MinerU] ${taskId}: v4 task_id = ${v4TaskId}`);

  // ===== Step 4: 轮询 v4 任务状态 =====
  console.log(`[MinerU] ${taskId}: Step4 - 轮询 v4 解析状态...`);
  let zipUrl = null;
  for (let i = 0; i < 120; i++) { // 最长等待 6 分钟
    await new Promise(r => setTimeout(r, 3000));
    const statusRes = await mineruReq('GET', `/api/v4/extract/task/${v4TaskId}`);
    const state = statusRes.body?.data?.state;
    const progress = statusRes.body?.data?.extract_progress;
    const pagesDone = progress?.extracted_pages ?? '?';
    const pagesTotal = progress?.total_pages ?? '?';
    console.log(`[MinerU] [${i+1}/120] state=${state} (${pagesDone}/${pagesTotal}页)`);

    if (state === 'done') {
      zipUrl = statusRes.body.data.full_zip_url;
      break;
    }
    if (state === 'failed') {
      throw new Error('MinerU v4 解析失败: ' + (statusRes.body.data?.err_msg || JSON.stringify(statusRes.body?.data || statusRes.body).substring(0, 500)));
    }
  }
  if (!zipUrl) throw new Error('MinerU v4 解析超时');
  console.log(`[MinerU] ${taskId}: 解析完成! ZIP URL: ${zipUrl.substring(0, 80)}...`);

  // ===== Step 5: 下载并解压 ZIP =====
  console.log(`[MinerU] ${taskId}: Step5 - 下载 ZIP...`);
  const zipBuffer = await downloadFile(zipUrl);
  console.log(`[MinerU] ${taskId}: ZIP 大小 ${(zipBuffer.length / 1024).toFixed(1)} KB`);

  const zip = new AdmZip(zipBuffer);
  const zipEntries = zip.getEntries();
  console.log(`[MinerU] ${taskId}: ZIP 包含 ${zipEntries.length} 个文件:`);
  zipEntries.forEach(e => console.log(`   ${e.entryName} (${e.header.size} bytes)`));

  // 解压所有文件到 taskDir
  zip.extractAllTo(taskDir, true); // overwrite=true
  console.log(`[MinerU] ${taskId}: 已解压到 ${taskDir}`);

  // ===== Step 6: 处理 Markdown 和图片 =====
  // 查找 full.md
  let allMd = '';
  const mdEntry = zipEntries.find(e => e.entryName.endsWith('full.md') || e.entryName.endsWith('/full.md'));
  if (mdEntry) {
    const mdPath = path.join(taskDir, mdEntry.entryName);
    if (fs.existsSync(mdPath)) {
      allMd = fs.readFileSync(mdPath, 'utf8');
      // 备份 raw.md
      fs.writeFileSync(path.join(taskDir, 'raw.md'), allMd, 'utf8');
      console.log(`[MinerU] ${taskId}: 读取 full.md, ${allMd.length} 字符`);
    }
  }
  if (!allMd) throw new Error('ZIP 中未找到 full.md');

  // 查找并处理图片 — MinerU v4 图片通常在 images/ 目录
  let imageCount = 0;
  const imgEntries = zipEntries.filter(e => {
    const name = e.entryName.toLowerCase();
    return /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(name) && !name.includes('__macosx');
  });

  // 建立 originalName -> webPath 映射
  const imgMapping = {}; // { original_name_in_md: web_path }

  for (const entry of imgEntries) {
    // ZIP 中的路径如 "images/abc123.jpg" 或 "full_files/images/abc123.jpg"
    const srcPath = path.join(taskDir, entry.entryName);

    // 目标路径：taskDir/img_N.ext
    const ext = path.extname(entry.entryName) || '.jpg';
    const localName = `img_${++imageCount}${ext}`;
    const destPath = path.join(taskDir, localName);
    const webPath = `/uploads/doc2x_images/${taskId}/${localName}`;

    if (fs.existsSync(srcPath)) {
      // 复制/移动到统一命名
      fs.copyFileSync(srcPath, destPath);
      // 记录映射：原始文件名（不含目录）→ web 路径
      const origBasename = path.basename(entry.entryName);
      imgMapping[origBasename] = webPath;
      imgMapping[entry.entryName] = webPath; // 也支持完整路径匹配
    }
  }
  console.log(`[MinerU] ${taskId}: 处理了 ${imageCount} 张图片`);

  // 替换 Markdown 中的图片引用为本地 web 路径
  // MinerU 格式通常是: ![alt](images/xxx.jpg) 或 ![alt](./images/xxx.jpg)
  let replacedImages = 0;
  for (const [origKey, webPath] of Object.entries(imgMapping)) {
    const origBasename = path.basename(origKey);
    // 尝试多种可能的 Markdown 图片引用格式
    const patterns = [
      new RegExp(`\\(!\\[[^\\]]*\\]\\(\\s*${escapeRegex(origKey)}\\s*\\)\\)`, 'g'),
      new RegExp(`\\(!\\[[^\\]]*\\]\\(\\s*[^)]*\\/${escapeRegex(origBasename)}\\s*\\)\\)`, 'g'),
      new RegExp(`<img\\s+[^>]*src=["']([^"']*${escapeRegex(origBasename)})["'][^>]*>`, 'gi'),
    ];
    for (const p of patterns) {
      const matches = allMd.match(p);
      if (matches) {
        allMd = allMd.replace(p, `(<img src="${webPath}"/>)`);
        replacedImages += matches.length;
      }
    }
  }
  // 兜底：替换任何剩余的 images/*.ext 引用
  allMd = allMd.replace(/!\[(?:<[^>]+>|[^)\]]*)\]\((?:\.\.?\/)?(images\/[^)]+)\)/g, (match, imgRelPath) => {
    const basename = path.basename(imgRelPath);
    if (imgMapping[basename]) {
      replacedImages++;
      return `(<img src="${imgMapping[basename]}"/>)`;
    }
    return match; // 无法映射则保留原样
  });

  console.log(`[MinerU] ${taskId}: 替换了 ${replacedImages} 个图片引用`);

  // 保存处理后的 MD
  fs.writeFileSync(path.join(taskDir, 'raw.md'), allMd, 'utf8');

  // ===== Step 7: 切题（复用现有引擎）=====
  console.log(`[MinerU] ${taskId}: Step7 - 切分题目...`);
  let questions = splitQuestionsFromMd(allMd);
  if (questions.length === 0) throw new Error('No questions detected from MinerU output');

  // 解析答案
  const hasAnswerSection = /(?:参考答案|【参考答案】|答案解析|试题解析|答案\s)(?![\s\S]{0,50}一、)/i.test(allMd);
  const answerMap = hasAnswerSection ? parseAnswersFromMd(allMd) : {};
  console.log(`[MinerU] ${taskId}: Answer parsing ${hasAnswerSection ? 'enabled' : 'skipped'}`);
  questions.forEach(q => {
    const a = answerMap[q.number];
    if (a) { if (a.answer) q.answer = a.answer; if (a.analysis) q.analysis = a.analysis; }
  });

  // 应用默认属性
  questions.forEach(q => {
    q.difficulty = q.difficulty || defaults.difficulty;
    q.grade = defaults.grade;
    q.categoryId = defaults.categoryId;
    q.categoryName = defaults.categoryName;
    q.confirmed = false;
  });

  // LLM 结构化解析
  console.log(`[MinerU] ${taskId}: LLM structured parsing...`);
  questions = await llmReparseQuestions(questions, taskId);

  // 收集所有有效图片
  const allImages = [];
  for (const wp of Object.values(imgMapping)) {
    try {
      const fullPath = __dirname + wp;
      if (fs.statSync(fullPath).size > 0) allImages.push(wp);
    } catch(e) {}
  }

  // 更新任务
  const tasks = readPdfTasks();
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.status = 'ready';
    task.totalPages = 1; // v4 返回单个完整 MD，不分页
    task.questionCount = questions.length;
    task.questions = questions;
    task.allImages = allImages;
    task.pageMd = [allMd]; // 单元素数组兼容 page-info 接口
    writePdfTasks(tasks);
  }
  console.log(`[MinerU] ${taskId}: Done — ${questions.length} questions, ${imageCount} images`);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ========== Doc2X 内容标准化引擎 ==========

/**
 * 清洗 Doc2X 输出的 Markdown，转换为题库内部格式
 * - 去除 HTML 注释、Meanless 标记
 * - $$...$$ → \[...\]（题库统一用 \[ \]）
 * - 压缩 LaTeX 中多余空格（{ 150 } → {150}）
 * - 去除表格、试卷页码等非题目内容
 * - 归一化题号格式
 */
function cleanDoc2xContent(md) {
  let text = md;

  // 1) 去除 HTML 注释
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // 2) 去除 Meanless 行
  text = text.replace(/Meanless:[\s\S]*?(?=\n|$)/g, '');

  // 3) 去除 HTML 表格（答案表格等）
  text = text.replace(/<table[\s\S]*?<\/table>/g, '');

  // 4) img 标签暂保留（后面单独处理），但先去掉 alt 等干扰属性
  text = text.replace(/<img\s+([^>]*?)src="([^"]+)"[^>]*>/g, (m, attrs, src) => {
    return `<img src="${src}"/>`;
  });

  // 5) 去除试卷/答案页码行
  text = text.replace(/(?:试卷|答案)第\s*\d+\s*页[\s\S]*?(?=\n)/g, '');
  text = text.replace(/班级.*?成绩[\s\S]*?(?=\n\s*\d)/g, '');

  // 6) 去除 Markdown 标题行（保留后面的 body，去掉标题装饰）
  text = text.replace(/^#{1,3}\s+.*$/gm, '\n');

  // 7) $$...$$ 或 $$ ... $$ → \[...\]（display math 统一格式）
  text = text.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (m, inner) => `\\[${inner.trim()}\\]`);
  // 单独的 $$ 块（跨行）
  text = text.replace(/\$\$\n([\s\S]*?)\n?\$\$/g, (m, inner) => `\\[${inner.trim()}\\]`);

  // 8) 清理 LaTeX 中多余空格
  // 花括号内多余空格: { 150 } → {150}，{ \circ } → {\circ}
  text = text.replace(/\{\s+([^{}\s]+(?:[^{}]*[^{}\s])?)\s+\}/g, '{$1}');
  // 但保护嵌套花括号：{ {3x} - \frac{\pi}{4} } → 保留
  // 只处理简单情况：{ xxx } 其中 xxx 不含花括号
  text = text.replace(/\{\s+([^{}]+?)\s+\}/g, (m, inner) => `{${inner.trim()}}`);

  // 9) 归一化题号分隔符
  text = text.replace(/^(\d{1,2})、/gm, '$1.');

  // 10) 合并多余空行（最多保留一个）
  text = text.replace(/\n{3,}/g, '\n\n');

  // 11) 去除页眉页脚残留
  text = text.replace(/^(?:命题人|考察范围|总分|时间|绝密|启用前).*$/gm, '');
  text = text.replace(/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}.*$/gm, '');

  return text.trim();
}

/**
 * 将 Doc2X 的 \(...\) 格式转换为题库标准格式
 * 题库内部使用 \(...\) 表示行内公式，\[...\] 表示行间公式
 * Doc2X 输出默认就是 \(...\)，所以主要工作是清理
 */
function normalizeMathDelimiters(text) {
  // 已经兼容，不需要转换
  // 但需要确保 \( 前面有空格或行首，后面紧贴内容
  // 清理错误的转义
  text = text.replace(/\\\\\(/g, '\\(');
  text = text.replace(/\\\\\)/g, '\\)');
  text = text.replace(/\\\\\[/g, '\\[');
  text = text.replace(/\\\\\]/g, '\\]');
  return text;
}

/**
 * 从清洗后的文本中提取图片引用并记录
 * 返回 { text: 清理后的文本, images: 图片 URL 数组 }
 */
function extractImageRefs(text) {
  const images = [];
  const imgRe = /<img\s+src="([^"]+)"\/>/g;
  let m;
  while ((m = imgRe.exec(text)) !== null) {
    images.push(m[1]);
  }
  // 去掉 img 标签，后续用 \img{} 替换
  text = text.replace(/<img\s+[^>]+\/>/g, '');
  return { text, images };
}


// ========== 题目切分引擎（增强版）==========

/**
 * 从 Doc2X Markdown 中切分题目
 * 增强特性：
 * - 多 section 题型自动检测
 * - 题号连续性验证
 * - 跳过非题目区域（标题、说明文字等）
 */
function splitQuestionsFromMd(md) {
  // === 第零步：在原始 md 上切掉"参考答案"部分（必须先做，避免答案被当成题目） ===
  // 支持的答案标题格式：
  //   《xxx》参考答案  /  ## 参考答案  /  参考答案  /  【参考答案】
  let questionOnly = md;
  const cutHeaderRe = /(^|\n)(?:#{1,3}\s*)?(?:《[^》]*》)?(?:参[考]?考[答]?案|参考答案|【参考答案】)\s*\n?/gm;
  let cutMatch, bestCutIdx = -1;
  while ((cutMatch = cutHeaderRe.exec(md)) !== null) {
    // 忽略试卷标题行（如 "四、解答题. 参考答案"）
    const before = md.substring(Math.max(0, cutMatch.index - 30), cutMatch.index);
    if (/[一二三四五六七八九十]/.test(before.trim().slice(-5))) continue;
    const candidateIdx = cutMatch.index; // 截断到标题之前，不含标题文字
    if (candidateIdx > bestCutIdx) bestCutIdx = candidateIdx;
  }
  // fallback：如果没匹配到标题，尝试找"参考答案"关键字
  if (bestCutIdx < 0) {
    const fallbackRe = /参[考]?考[答]?案[\s\S]*?(?=\n\s*\d{1,2}[\.、．]\s*([A-D]{1,4}\s)?(?:【详解】|【解析】))/;
    const fm = md.match(fallbackRe);
    if (fm && fm.index > 100) { // 至少100字符后（避免正文中的"参考"误判）
      bestCutIdx = fm.index;
    }
  }
  if (bestCutIdx > 0) {
    questionOnly = md.substring(0, bestCutIdx).trim();
  }

  // === 第一步：清洗（只清洗题目部分，不影响 parseAnswersFromMd 用的原始 md） ===
  let clean = cleanDoc2xContent(questionOnly);
  clean = normalizeMathDelimiters(clean);

  // === 第二步：检测所有 section 断点和题型（在 clean 上检测） ===
  const sectionPatterns = [
    { re: /^#{1,3}\s*(.+?)$/gm },
    { re: /^[一二三四五六七八九十]、\s*(.+?)$/gm },
    { re: /^（[一二三四五六七八九十]）\s*(.+?)$/gm },
  ];

  const sections = []; // [{ pos, text, title, type }]
  for (const { re } of sectionPatterns) {
    let m;
    while ((m = re.exec(clean)) !== null) {
      sections.push({ pos: m.index, text: m[0], title: m[1] || m[0], type: detectTypeFromTitle(m[1] || m[0]) });
    }
  }
  sections.sort((a, b) => a.pos - b.pos);

  // === 第三步：按 section 区间切题（在 clean 上切） ===
  if (sections.length <= 1) {
    const allBodies = extractQuestionBodies(clean);
    if (sections.length === 1 && sections[0].type) {
      allBodies.forEach(b => b.type = sections[0].type);
    }
    return buildQuestions(allBodies);
  }

  const allQuestions = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const nextSec = sections[i + 1];
    const startPos = sec.pos + sec.text.length;
    const endPos = nextSec ? nextSec.pos : clean.length;
    let segmentMd = clean.substring(startPos, endPos);

    segmentMd = cleanDoc2xContent(segmentMd);
    segmentMd = normalizeMathDelimiters(segmentMd);

    const bodies = extractQuestionBodies(segmentMd);
    bodies.forEach(b => b.type = sec.type || '单选');
    const qs = buildQuestions(bodies);
    allQuestions.push(...qs);
  }

  return allQuestions;
}

/**
 * 从 section 标题推断题型
 */
function detectTypeFromTitle(title) {
  if (!title) return null;
  const t = title.replace(/[\s#（）()]/g, '');
  if (/多选/.test(t)) return '多选';
  if (/单选|选择/.test(t) && !/多选/.test(t)) return '单选';
  if (/填空/.test(t)) return '填空';
  if (/解答|大题|计算|证明|综合/.test(t)) return '解答';
  return null;
}

/**
 * 从一段文本中按题号提取题目体
 * 返回 [{ number, body, type }]
 */
function extractQuestionBodies(text) {
  // 跳过明显不是题目的前导内容（标题、说明等）
  const lines = text.split('\n');
  let startFrom = 0;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const l = lines[i].trim();
    if (!l || /^(?:一、|二、|三、|四、|五、|六、)/.test(l) ||
        /^(?:第[IVX]+卷|选择题|非选择题|填空题|解答题)/.test(l) ||
        /^(?:每小题|本题|每题|共\d+题)/.test(l) ||
        /^(?:在每小题|请将答案|注意事项)/.test(l)) {
      startFrom = i + 1;
    } else if (/^\d{1,2}[\.、．]/.test(l)) {
      break; // 找到第一道题了
    }
  }
  text = lines.slice(startFrom).join('\n');

  // 按题号切分（支持 1. 1、 1．等格式，点号后允许无空格）
  const splitRe = /(?:\n|^)\s*(\d{1,2})[\.、．]\s*/g;
  const bodies = [];
  let lastIdx = 0, lastNum = 0;
  let m;

  while ((m = splitRe.exec(text)) !== null) {
    if (lastIdx > 0 && m.index > lastIdx) {
      bodies.push({ number: lastNum, body: text.substring(lastIdx, m.index).trim(), type: '单选' });
    }
    lastIdx = m.index + m[0].length;
    lastNum = parseInt(m[1]);
  }
  if (lastIdx > 0 && lastIdx < text.length) {
    bodies.push({ number: lastNum, body: text.substring(lastIdx).trim(), type: '单选' });
  }

  // === 图片漂移修正 ===
  // 如果一个 body 的尾部只有图片（无实质文字），且下一个 body 以"如图"开头，
  // 则将这些图片移到下一个 body（图片属于下一题）
  for (let i = 0; i < bodies.length - 1; i++) {
    const current = bodies[i];
    const nextBody = bodies[i + 1];
    // 检查当前 body 尾部是否只有图片标签
    const imgTagRe = /(?:\n|<)\s*<img\s+src="[^"]+"\/>\s*$/;
    const trailingImgsMatch = current.body.match(/((?:\s*<img\s+src="[^"]+"\/>\s*\n?)+)$/);
    if (trailingImgsMatch) {
      const beforeImg = current.body.substring(0, current.body.length - trailingImgsMatch[0].length).trim();
      // 如果去掉图片后，剩余内容很短（<30字符），说明这主要是图片占位
      const nextStartsWithRutu = /如图/.test(nextBody.body.substring(0, 20));
      if (nextStartsWithRutu || beforeImg.length < 30) {
        // 将图片移到下一个 body 的头部
        bodies[i + 1].body = trailingImgsMatch[1].trim() + '\n' + nextBody.body;
        current.body = beforeImg;
      }
    }
  }

  // 去掉第一个 body 头部的装饰性图片（页面标题图、logo 等）
  if (bodies.length > 0) {
    const first = bodies[0];
    const leadingImgs = first.body.match(/^((?:\s*<img\s+src="[^"]+"\/>\s*\n?)+)/);
    if (leadingImgs) {
      const afterImg = first.body.substring(leadingImgs[0].length).trim();
      // 如果去掉头部图片后仍有实质内容（超过 15 字符），则去掉这些图片
      if (afterImg.length > 15) {
        first.body = afterImg;
      }
    }
  }

  return bodies;
}

/**
 * 从题目体数组构建标准 question 对象
 */
function buildQuestions(bodies) {
  return bodies.map(b => {
    // 提取图片
    const { text: noImgText, images: imgUrls } = extractImageRefs(b.body);

    // 提取选项
    const { body: cleanBody, options } = extractOptionsFromText(noImgText);

    // 自动类型推断（如果没有从 section 获得）
    let autoType = b.type || '单选';
    if (options.length === 0 && /解答|证明|计算|化简|求值|解方程/.test(cleanBody.substring(0, 40))) {
      autoType = '解答';
    } else if (options.length === 0 && /[\u005f]{2,}|\\underline|___/.test(cleanBody)) {
      autoType = '填空';
    } else if (options.length > 4) {
      autoType = '多选';
    }

    // 清理 content 末尾：去掉多余答题空 （ ）（ ）/（ ）、连续空白
    let finalContent = cleanBody
      .replace(/[\s]*（\s*[）)][\s]*（\s*[）)]+[\s]*$/g, '（ ）')  // 多个合并为一个
      .replace(/[\s]*（\s*[）)][\s]*$/, '')                          // 去掉单个
      .trim();

    return {
      number: b.number,
      type: autoType,
      content: finalContent || cleanBody,
      options: options.map(opt => cleanOptionText(opt)),
      images: imgUrls,
      answer: '',
      analysis: '',
      difficulty: '中',
      confirmed: false
    };
  });
}


// ========== 选项提取（增强版）==========

/**
 * 从题目正文中提取 ABCD 选项
 * 支持格式：
 *   A. xxx B. xxx C. xxx D. xxx（空格分隔）
 *   A．xxx\nB．xxx\nC．xxx\nD．xxx（换行分隔）
 *   A) xxx  B) xxx（括号分隔）
 */
function extractOptionsFromText(body) {
  const options = [];
  let cleanBody = body;

  // Step 1: Find all lines starting with A.-D.
  const lineSepRe = /^\s*([A-D])[\.．\uFF0E)]\s*(.+)$/gm;
  const lineOpts = [];
  let lm;
  while ((lm = lineSepRe.exec(body)) !== null) {
    lineOpts.push({ label: lm[1], text: lm[2].trim(), index: lm.index, full: lm[0] });
  }

  // Step 1a: >=2 independent lines, each containing only one option
  if (lineOpts.length >= 2) {
    const allSingle = lineOpts.every(function(o) { return !/[A-D][\.．\uFF0E)]/.test(o.text.substring(0, 80)); });
    if (allSingle) {
      lineOpts.forEach(function(o) { options.push(o.label + '. ' + o.text); });
      cleanBody = body.substring(0, lineOpts[0].index).trim().replace(/[\（(][\s]*$/g, '') + '（ ）';
      return { body: cleanBody, options: options };
    }
  }

  // Step 1b: Option lines contain multiple options merged together
  if (lineOpts.length >= 1) {
    var optBlockText = '';
    var optStartIdx = lineOpts[0].index;
    for (var i = 0; i < lineOpts.length; i++) {
      optBlockText += (i > 0 ? '\n' : '') + lineOpts[i].full.trim();
      if (i < lineOpts.length - 1) {
        var gap = body.substring(lineOpts[i].index + lineOpts[i].full.length, lineOpts[i + 1].index);
        if (gap.split('\n').length > 3) break;
      }
    }

    // Position-based scanning: find ALL A.-D. marker positions, then slice between them
    // This correctly handles "A. xxx B. xxx C. xxx D. xxx" on same or crossed lines
    var markerRe = /([A-D])[\.．\uFF0E)]/g;
    var positions = [];
    var pm;
    while ((pm = markerRe.exec(optBlockText)) !== null) {
      // Skip markers inside LaTeX commands like \mathrm{B}. or \text{A}.
      // These appear as "{X." in the text
      var charBefore = pm.index > 0 ? optBlockText[pm.index - 1] : '';
      if (charBefore === '{' || charBefore === '\\') continue;
      positions.push({ label: pm[1], absPos: pm.index, markLen: pm[0].length });
    }
    if (positions.length >= 2) {
      var slicedOpts = [];
      for (var j = 0; j < positions.length; j++) {
        var txtStart = positions[j].absPos + positions[j].markLen;
        var txtEnd = (j + 1 < positions.length) ? positions[j + 1].absPos : optBlockText.length;
        var optTxt = optBlockText.substring(txtStart, txtEnd).trim()
          .replace(/^[A-D][\.．\uFF0E)]\s*/, '');  // remove leading marker if any
        // Skip if this looks like a duplicate marker only (e.g., image-only option "A.")
        if (optTxt && optTxt.length > 0 && !/^[A-D][\.．\uFF0E)]\s*$/.test(optTxt)) {
          slicedOpts.push(positions[j].label + '. ' + optTxt);
        }
      }
      if (slicedOpts.length >= 2) {
        options.push.apply(options, slicedOpts);
        cleanBody = body.substring(0, optStartIdx).trim().replace(/[\（(][\s]*$/g, '') + '（ ）';
        return { body: cleanBody, options: options };
      }
    }
  }

  // Step 2: Inline type - question and options on same line (no newline before options)
  var inlineRe = /(?:^|\s)([A-D])[\.．\uFF0E)]\s*(.+?)(?=\s+(?:[A-D][\.．\uFF0E])|$)/g;
  var sm;
  while ((sm = inlineRe.exec(body)) !== null) {
    if (sm[2].trim()) options.push(sm[1] + '. ' + sm[2].trim().replace(/^[A-D][\.．\uFF0E)]\s+/, ""));
  }
  if (options.length >= 2) {
    var firstMatch = body.match(/(?:^|\s)([A-D])[\.．\uFF0E)]/);
    if (firstMatch && firstMatch.index > 0) {
      cleanBody = body.substring(0, firstMatch.index).trim().replace(/[\（(][\s]*$/g, '') + '（ ）';
    } else {
      cleanBody = body.replace(/\s*[A-D][\.．\uFF0E)].*$/, '').trim() + '（ ）';
    }
    return { body: cleanBody, options: options };
  }

  return { body: cleanBody, options: options };
}
/**
 * 清理选项文本（去多余空格、去前缀字母+分隔符）
 * 输入 "A. \( \\frac{1}{2} \)" → 输出 "\( \\frac{1}{2} \)"
 */
function cleanOptionText(opt) {
  // 去掉前缀 A. A．A) 等
  return opt.replace(/^[A-D][\.．)]\s*/, '').trim();
}


// ========== 答案解析（增强版）==========

/**
 * 从 Markdown 中提取答案和解析
 * 支持格式：
 *   1. 答案表格（HTML table）
 *   2. 逐题详解（"1. B 【详解】..."）
 *   3. 简略答案（"1-5 ABCCD 6-10 BACDA"）
 *   4. 答案区 Markdown（"参考答案" 或 "答案" section）
 */
function parseAnswersFromMd(md) {
  const result = {};

  // === 策略 1: HTML 答案表格 ===
  const tableRe = /<table>[\s\S]*?<tr>[\s\S]*?<td>\s*题号\s*<\/td>(.*?)<\/tr>\s*<tr>[\s\S]*?<td>\s*答案\s*<\/td>(.*?)<\/tr>[\s\S]*?<\/table>/gi;
  let tableM;
  while ((tableM = tableRe.exec(md)) !== null) {
    const numRe = /<td>([^<]*)<\/td>/g;
    let nm;
    const numbers = [];
    while ((nm = numRe.exec(tableM[1])) !== null) {
      const n = parseInt(nm[1]);
      if (!isNaN(n) && n >= 1 && n <= 50) numbers.push(n);
    }
    const answers = [];
    while ((nm = numRe.exec(tableM[2])) !== null) {
      answers.push(nm[1].trim());
    }
    for (let i = 0; i < Math.min(numbers.length, answers.length); i++) {
      if (!result[numbers[i]]) result[numbers[i]] = { answer: '', analysis: '' };
      if (!result[numbers[i]].answer) result[numbers[i]].answer = answers[i];
    }
  }

  // === 策略 1b: Markdown 文本答案表格（无标题，PaddleOCR-VL 常见格式） ===
  // 格式：题号 | 1 | 2 | 3 \n ---|---|---\n 答案 | A | B | C
  let mdTm = null;
  {
    const _mdtr = /^\s*(?:题号|序号)\s*\|([\s\S]*?)\n\s*[-|:\s]+\n\s*(?:答案)\s*\|([\s\S]*?)(?=\n\n|\n\s*\d{1,2}[\.、．]\s*[A-D]|\s*$)/im;
    const _mtm = md.match(_mdtr);
    if (_mtm) {
      mdTm = _mtm;
      const _nl = mdTm[1], _al = mdTm[2];
      const _nums = _nl.split('|').map(function(s){return parseInt(s.trim());}).filter(function(n){return !isNaN(n)&&n>=1&&n<=50;});
      const _ans = _al.split('|').map(function(s){return s.trim();}).filter(function(s){return /^[A-Da-d]$/.test(s);});
      console.log('[parseAnswersFromMd] MD表格: 题号=['+_nums.join(',')+'] 答案=['+_ans.join(',')+']');
      for(let _i=0;_i<Math.min(_nums.length,_ans.length);_i++){if(!result[_nums[_i]])result[_nums[_i]]={answer:'',analysis:''};if(!result[_nums[_i]].answer)result[_nums[_i]].answer=_ans[_i].toUpperCase();}
    }
  }

  // === 策略 2: 逐题详解（"1. C" 或 "1.C 【详解】..."） ===
  // ⚠️ 触发条件：有「参考答案」标题 OR 有 Markdown 答案表格（策略1b mdTm）
  //    否则跳过，避免在题目正文里误匹配
  let answerSection = null;
  const ansSepRe = /(?:^|\n)(?:#{1,3}\s*)?(?:《[^》]*》)?(?:参[考]?考[答]?案|【参考答案】)\s*\n/;
  const am = md.match(ansSepRe);
  if (am || mdTm) {
    // 有标题 → 从标题后开始；无标题有表格 → 从表格后开始
    const sectionStart = am ? (am.index + am[0].length) : (mdTm.index + mdTm[0].length);
    answerSection = md.substring(sectionStart);
    // 同行多条目拆分：仅当 A-D 字母后紧跟下一个题号+字母时才插入换行
    answerSection = answerSection.replace(
      /(\d{1,2}[\.、．]\s*[A-D]{1,4}\s*\.?\s*)(?=\d{1,2}[\.、．]\s*[A-D])/g,
      '$1\n'
    );

    const detailRe = /(\d{1,2})[\.、．]\s*([A-D]{1,4})?\s*(?:[\.、．]\s*)?(?:【详解】|【解析】|【答案】)?\s*([\s\S]*?)(?=(?:\n\s*\d{1,2}[\.、．]\s*)|$)/g;
    let dm;
    while ((dm = detailRe.exec(answerSection)) !== null) {
      const num = parseInt(dm[1]);
      const ans = (dm[2] || '').trim();
      let analysis = (dm[3] || '').trim().replace(/^(?:【详解】|【解析】|【答案】)\s*/, '').trim();

      if (!isNaN(num) && num >= 1 && num <= 50) {
        if (!result[num]) result[num] = { answer: '', analysis: '' };
        if (ans && !result[num].answer) result[num].answer = ans;
        if (analysis && analysis.length < 500 && !result[num].analysis) {
          // 安全检查：analysis 前20字内不应出现选项标记，否则是误匹配了题目正文
          const looksLikeQuestion = /^[A-D][\.．\uFF0E)]/m.test(analysis.substring(0, Math.min(20, analysis.length)));
          if (!looksLikeQuestion) {
            result[num].analysis = analysis
              .replace(/<img\s+[^>]+>/g, '')
              .replace(/<[^>]+>/g, '')
              .trim();
          }
        }
      }
    }
  }

  // === 策略 3: 简略答案（"1-5 ABCCD" 格式） ===
  const rangeRe = /(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+([A-Da-d]+)/g;
  let rm;
  while ((rm = rangeRe.exec(md)) !== null) {
    const start = parseInt(rm[1]);
    const end = parseInt(rm[2]);
    const answers = rm[3].trim().toUpperCase();
    for (let i = 0; i < answers.length && start + i <= end; i++) {
      const qnum = start + i;
      if (!result[qnum]) result[qnum] = { answer: '', analysis: '' };
      if (!result[qnum].answer) result[qnum].answer = answers[i];
    }
  }

  // === 策略 4: 答案/解析 section ===
  const sections = [
    { re: /参考答案[\s\S]*?$/g, label: 'answer' },
    { re: /答案解析[\s\S]*?$/g, label: 'analysis' },
    { re: /试题解析[\s\S]*?$/g, label: 'analysis' },
  ];

  for (const { re, label } of sections) {
    const sm = md.match(re);
    if (sm) {
      const sectionText = sm[0];
      // 尝试提取带 \\( 或 $ 的答案
      const inlineAnswers = [...sectionText.matchAll(/(\d{1,2})[\.、．]\s*(.+?)(?=(?:\n\s*\d{1,2}[\.、．])|\n\s*$)/g)];
      for (const ia of inlineAnswers) {
        const num = parseInt(ia[1]);
        const content = ia[2].trim();
        if (!isNaN(num) && num >= 1 && num <= 50) {
          if (!result[num]) result[num] = { answer: '', analysis: '' };
          if (label === 'answer' && !result[num].answer) result[num].answer = content;
          if (label === 'analysis' && !result[num].analysis) result[num].analysis = content;
        }
      }
    }
  }

  return result;
}

console.log('[PDF Batch Inline] 内联路由和 Doc2X 处理已注册');

// 生产模式：服务前端静态文件
const DIST_DIR = path.join(__dirname, 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA 路由回退（Express 5 语法）
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// 启动服务器
app.listen(PORT, () => {
  console.log('试题库后端服务运行在 http://localhost:' + PORT);
  console.log('数据目录: ' + DATA_DIR);
  if (fs.existsSync(DIST_DIR)) console.log('前端静态文件: ' + DIST_DIR);
});
