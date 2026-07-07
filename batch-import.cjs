// batch-import.cjs - 批量录题 API（ require 挂到 server.cjs）
// 用法：在 server.cjs 末尾添加：
//   require('./batch-import.cjs')(app, path, fs, JSZip, sharp);

const { execFileSync } = require('child_process');
const crypto = require('crypto');

module.exports = function installBatchImport(app, path, fs, JSZip, sharp) {

  const DATA_DIR = path.join(__dirname, 'data');
  const IMAGES_DIR = path.join(__dirname, 'uploads', 'images');
  const SESSIONS_DIR = path.join(DATA_DIR, 'batch_sessions');
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  // ========== 工具：字符级花括号解析 ==========
  // 从 text 的 startIdx 开始，找到第一个 {，返回括号内的 content（配对的）
  function extractBracedContent(text, startIdx) {
    // 跳过空白和命令名，找到第一个 {
    let i = startIdx;
    while (i < text.length && text[i] !== '{') {
      if (text[i] === '\\') i++; // 跳过转义字符
      i++;
    }
    if (i >= text.length) return null;
    let depth = 1;
    let j = i + 1;
    let inMath = false;
    while (j < text.length && depth > 0) {
      const c = text[j];
      // 跳过 LaTeX 数学模式
      if (c === '\\' && j + 1 < text.length) {
        const n = text[j + 1];
        if (n === '(' || n === '[') {
          const endM = n === '(' ? '\\)' : '\\]';
          const ei = text.indexOf(endM, j + 2);
          if (ei !== -1) { j = ei + endM.length; continue; }
        }
        j += 2; continue;
      }
      if (c === '$') {
        const ei = text.indexOf('$', j + 1);
        if (ei !== -1) { j = ei + 1; continue; }
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      j++;
    }
    if (depth === 0) return text.slice(i + 1, j - 1);
    return null;
  }

  // 提取命令的所有参数（{...} 形式，支持多个）
  function extractAllArgs(text, cmdStartIdx, cmdLen) {
    const args = [];
    let pos = cmdStartIdx + cmdLen;
    // 跳过空白
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    while (pos < text.length && text[pos] === '{') {
      const content = extractBracedContent(text, pos);
      if (content === null) break;
      args.push(content);
      pos += content.length + 2; // 跳过 { 和 }
      while (pos < text.length && /\s/.test(text[pos])) pos++;
    }
    return args;
  }

  // ========== 工具：在 ZIP 目录中找图片 ==========
  function findImageInDir(imgPath, texDir, extractDir) {
    // 规范化路径分隔符（处理 Windows/Unix 混用）
    const norm = (p) => p.replace(/\\/g, '/');
    const candidates = [
      path.join(extractDir, imgPath),
      path.join(texDir, imgPath),
      path.resolve(texDir, imgPath),
      // 尝试去掉父目录，只按文件名找（常见于图片和 tex 在同一目录）
      path.join(texDir, path.basename(imgPath)),
      path.join(extractDir, path.basename(imgPath)),
      // 尝试上级目录 + imgPath（如果 tex 在子目录里，图片在根目录）
      path.join(path.dirname(texDir), imgPath),
      path.join(path.dirname(extractDir), imgPath),
    ];
    // 去重
    const seen = new Set();
    for (const p of candidates) {
      const key = norm(p);
      if (seen.has(key)) continue;
      seen.add(key);
      if (fs.existsSync(p)) {
        console.log('[batch-import] 图片找到:', p);
        return p;
      }
    }
    // 递归按文件名搜索
    function walk(dir) {
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const it of items) {
          const full = path.join(dir, it.name);
          if (it.isFile() && it.name === path.basename(imgPath)) return full;
          if (it.isDirectory()) {
            const found = walk(full);
            if (found) return found;
          }
        }
      } catch { return null; }
      return null;
    }
    const found = walk(extractDir);
    if (found) {
      console.log('[batch-import] 图片递归找到:', found);
      return found;
    }
    console.log('[batch-import] 图片未找到:', imgPath, '| texDir:', texDir, '| extractDir:', extractDir);
    return null;
  }

  // ========== 工具：剥离 LaTeX 环境（保留内部内容）==========
  function stripLaTeXEnvironment(text, envName) {
    const beginStr = '\\begin{' + envName + '}';
    const endStr = '\\end{' + envName + '}';
    let result = text;
    let idx = 0;
    while (true) {
      const start = result.indexOf(beginStr, idx);
      if (start === -1) break;
      // 跳过 \begin{env} 后面的可选参数 [...] 和必填参数 {...}
      let pos = start + beginStr.length;
      while (pos < result.length && /\s/.test(result[pos])) pos++;
      // 跳过 [...]
      if (pos < result.length && result[pos] === '[') {
        let depth = 1;
        pos++;
        while (pos < result.length && depth > 0) {
          if (result[pos] === '[') depth++;
          else if (result[pos] === ']') depth--;
          pos++;
        }
      }
      while (pos < result.length && /\s/.test(result[pos])) pos++;
      // 跳过 {...}
      if (pos < result.length && result[pos] === '{') {
        let depth = 1;
        pos++;
        while (pos < result.length && depth > 0) {
          if (result[pos] === '{') depth++;
          else if (result[pos] === '}') depth--;
          pos++;
        }
      }
      // 找匹配的 \end{env}
      const endPos = result.indexOf(endStr, pos);
      if (endPos === -1) break;
      const inner = result.slice(pos, endPos);
      result = result.slice(0, start) + inner + result.slice(endPos + endStr.length);
      idx = start;
    }
    return result;
  }

  // 清理常见 LaTeX 排版残留
  function cleanLatexArtifacts(text) {
    if (!text) return text;
    let t = text;

    // 先用正则快速剥离常见环境（保留内容）——作为字符级 parser 的 fallback
    const envRegexFallback = [
      { name: 'minipage',  re: /\\begin\{minipage\}(?:\[[^\]]*\])?(?:\{[^}]*\})?([\s\S]*?)\\end\{minipage\}/g },
      { name: 'itemize',   re: /\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g },
      { name: 'enumerate', re: /\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g },
      { name: 'tabular',   re: /\\begin\{tabular\}(?:\{[^}]*\})([\s\S]*?)\\end\{tabular\}/g },
      { name: 'center',    re: /\\begin\{center\}([\s\S]*?)\\end\{center\}/g },
    ];
    for (const { re } of envRegexFallback) {
      t = t.replace(re, '$1');
    }

    // 再用字符级 parser 兜底（处理嵌套情况）
    const envsToStrip = ['itemize', 'enumerate', 'minipage', 'tabular', 'center', 'flushleft', 'flushright'];
    for (const env of envsToStrip) {
      t = stripLaTeXEnvironment(t, env);
    }

    // 清理独立排版命令（保留数学命令如 \left \right）
    t = t
      .replace(/\\hfill\b/g, '')
      .replace(/\\vfill\b/g, '')
      .replace(/\\quad\b/g, ' ')
      .replace(/\\qquad\b/g, '  ')
      .replace(/\\vspace\*?\{[^}]*\}/g, '')
      .replace(/\\vskip\*?\{[^}]*\}/g, '')
      .replace(/\\hspace\*?\{[^}]*\}/g, ' ')
      .replace(/\\smallskip\b/g, '')
      .replace(/\\medskip\b/g, '')
      .replace(/\\bigskip\b/g, '')
      .replace(/\\newpage\b/g, '')
      .replace(/\\pagebreak\b/g, '')
      .replace(/\\linebreak\b/g, '')
      .replace(/\\newline\b/g, '')
      .replace(/\\noindent\b/g, '')
      .replace(/\\indent\b/g, '')
      .replace(/\\centering\b/g, '')
      .replace(/\\raggedright\b/g, '')
      .replace(/\\raggedleft\b/g, '')
      .replace(/\\displaystyle\b/g, '')
      .replace(/\\textstyle\b/g, '')
      .replace(/\\scriptstyle\b/g, '')
      .replace(/\\scriptscriptstyle\b/g, '')
      .replace(/\\label\{[^}]*\}/g, '')
      .replace(/\\ref\{[^}]*\}/g, '')
      .replace(/\\\\(?=\s|$)/g, '\n')    // \\ 后紧跟空白或行尾 → 换行
      .replace(/\n{3,}/g, '\n\n');          // 压缩多余空行
    return t.trim();
  }

  // ========== 解析单道题目 ==========
  function parseOneQuestion(content, answer, texFullPath, extractDir) {
    // 1. 标题：取纯文本前30字
    let title = content
      .replace(/\\[a-zA-Z]+(\*?)(\[[^\]]*\])?(\{[^}]*\})?/g, '')
      .replace(/[{}]/g, '').replace(/\$/g, '').replace(/\\/g, '')
      .trim().slice(0, 30) || '未命名题目';

    // 2. 题型判断
    let type = '解答';
    const hasAbcd = / [A-D]\.\s/.test(content);
    const hasItem = /\\item\s/.test(content);
    if (hasAbcd || hasItem) {
      // 检查题干中是否标明“多选”或“多选题”
      // 查看选项之前的 stem 部分
      const stemMatch = content.match(/^[\s\S]*?(?=[A-D]\.\s|\\item)/);
      const stem = stemMatch ? stemMatch[0] : content;
      type = /多选/.test(stem || '') ? '多选' : '单选';
    }

    // 检测填空
    if (/\\underline|\\fillin|\\hspace/.test(content) && type === '解答') type = '填空';

    // 3. 提取选项
    let options = [];
    if (type === '单选' || type === '多选') {
      // A. B. C. D. 格式
      const firstOpt = content.search(/ [A-D]\.\s/);
      if (firstOpt > 0) {
        const stem = content.slice(0, firstOpt).trim();
        const optsPart = content.slice(firstOpt);
        const raw = optsPart.split(/ (?=[A-D]\.\s)/);
        // raw[0] 可能是 "A. 选项文本"（本身就是第一个选项），不要 slice(1) 跳过
        const firstIsOpt = /^[A-D]\.\s/.test(raw[0] || '');
        options = (firstIsOpt ? raw : raw.slice(1)).map(s => s.trim().replace(/^[A-D]\.\s*/, '').trim()).filter(Boolean);
        content = stem; // 题干不含选项
      }
      // \item 格式（更稳健的提取）
      if (hasItem) {
        // 找到第一个 \item 位置（允许 \item 后无空格）
        const firstItemIdx = content.search(/\\item\s*/);
        if (firstItemIdx >= 0) {
          const stem = content.slice(0, firstItemIdx).trim();
          const rest = content.slice(firstItemIdx);
          // 按 \item 切分，跳过空字符串（允许 \item 后无空格）
          const parts = rest.split(/\\item\s*/);
          const items = parts.slice(1).map(p => p.trim()).filter(Boolean);
          if (items.length > 0) {
            options = items;
            content = stem;
          }
        }
      }
    }

    // 4. 先剥离 minipage 环境（保留内部内容），暴露 \includegraphics 到顶层
    //    必须在图片处理之前执行，否则图片路径被 minipage 包裹导致无法识别
    content = content.replace(/\\begin\{minipage\}(?:\[[^\]]*\])?(?:\{[^}]*\})?([\s\S]*?)\\end\{minipage\}/g, '$1');
    if (answer) answer = answer.replace(/\\begin\{minipage\}(?:\[[^\]]*\])?(?:\{[^}]*\})?([\s\S]*?)\\end\{minipage\}/g, '$1');
    // 字符级 parser 兜底（处理嵌套 minipage）
    content = stripLaTeXEnvironment(content, 'minipage');
    if (answer) answer = stripLaTeXEnvironment(answer, 'minipage');

    // 4.x 处理 \includegraphics → 复制图片 → 替换成 \img{key}
    let images = {};
    const imgPat = /\\includegraphics(\[[^\]]*\])?\{([^}]+)\}/g;
    let m;
    // 必须用 while + exec，不能用 replace（content 会变）
    const imgMatches = [];
    let tmp = content;
    // 先收集所有图片路径
    const allImgPaths = [];
    let execTmp = content;
    let em;
    while ((em = imgPat.exec(execTmp)) !== null) {
      allImgPaths.push(em[2]);
    }
    for (const imgPath of allImgPaths) {
      const found = findImageInDir(imgPath, path.dirname(texFullPath), extractDir);
      let key;
      if (found) {
        key = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        const ext = path.extname(found);
        const destName = key + ext;
        const destPath = path.join(IMAGES_DIR, destName);
        if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
        try {
          sharp(found).jpeg({ quality: 92 }).toFile(destPath);
        } catch {
          try { fs.copyFileSync(found, destPath); } catch (e) {
            console.log('[batch-import] 图片复制失败，使用路径占位:', imgPath);
            key = imgPath;
          }
        }
        if (key !== imgPath) {
          images[key] = '/uploads/images/' + destName;
        }
      } else {
        console.log('[batch-import] 图片未找到:', imgPath, 'in', texFullPath);
        key = imgPath; // 用原路径作为 key，预览时会显示 "[图片: xxx 未找到]"
      }
      // 始终替换 content / answer 中的 \includegraphics 为 \img{key}
      const esc = imgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const replacer = '\\img{' + key + '}';
      const re = new RegExp('\\\\includegraphics(\\[[^\\]]*\\])?\\{' + esc + '\\}', 'g');
      content = content.replace(re, replacer);
      if (answer) {
        answer = answer.replace(re, replacer);
      }
    }

    // 4.8 清理 LaTeX 残留代码
    //   ⚠️ 注意：cleanLatexArtifacts 会剥离 \hspace、\qquad 等命令，
    //   因此 \underline 修复必须在 cleanLatexArtifacts 之后执行，否则 \underline{\qquad} → \underline{  } 不可见
    content = cleanLatexArtifacts(content);
    if (answer) answer = cleanLatexArtifacts(answer);
    if (options.length > 0) {
      options = options.map(opt => cleanLatexArtifacts(opt)).filter(Boolean);
    }

    // 4.9 修复 \underline（必须在 cleanLatexArtifacts 之后）
    content = content.replace(/\\underline\{\\hspace\*?\{[^}]*\}\}/g, '\\underline{\\qquad}');
    content = content.replace(/\\underline\{\s*\}/g, '\\underline{\\qquad}');
    if (answer) {
      answer = answer.replace(/\\underline\{\\hspace\*?\{[^}]*\}\}/g, '\\underline{\\qquad}');
      answer = answer.replace(/\\underline\{\s*\}/g, '\\underline{\\qquad}');
    }

    // 5. 答案处理
    let finalAnswer = '';
    if (type === '单选' || type === '多选') {
      const letters = (answer || '').match(/[A-D](?=\s|\)|\.)/g);
      finalAnswer = letters ? letters.join('') : (answer || '').trim().slice(0, 50);
    } else {
      finalAnswer = (answer || '').trim().slice(0, 200);
    }

    return {
      title,
      content,
      answerContent: finalAnswer,
      analysis: answer || '',
      options: options.length > 0 ? options : undefined,
      answer: finalAnswer,
      type,
      difficulty: '中',
      grade: '高一',
      tags: [],
      source: '',
      images,
    };
  }

  // ========== 清理 LaTeX 注释（保留数学模式中的 %）==========
  function stripComments(text) {
    let result = '';
    let i = 0;
    while (i < text.length) {
      // 跳过数学模式
      if (text[i] === '\\' && i + 1 < text.length) {
        const n = text[i + 1];
        if (n === '(' || n === '[') {
          const endM = n === '(' ? '\\)' : '\\]';
          const ei = text.indexOf(endM, i + 2);
          if (ei !== -1) { result += text.slice(i, ei + endM.length); i = ei + endM.length; continue; }
        }
      }
      if (text[i] === '$') {
        const ei = text.indexOf('$', i + 1);
        if (ei !== -1) { result += text.slice(i, ei + 1); i = ei + 1; continue; }
      }
      if (text[i] === '%') {
        while (i < text.length && text[i] !== '\n') i++;
        if (i < text.length) { i++; continue; } // 跳过 \n
      }
      result += text[i];
      i++;
    }
    return result;
  }

  // ========== 工具：规范化 LaTeX 内容（用于去重比对）==========
  function normalizeTexContent(content) {
    return content
      .replace(/%.*/g, '')                  // 去掉注释
      .replace(/\\s+/g, ' ')                // 多个空白符合并为一个空格
      .replace(/\s*([{}])\s*/g, '$1')    // 去掉花括号附近的空白
      .trim();
  }

  // 计算题目内容哈希（用于去重）
  function calcQuestionHash(content, answer) {
    const norm = normalizeTexContent(content) + '||' + normalizeTexContent(answer || '');
    return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
  }

  // ========== 解析 .tex 文件，提取所有 \Practice 和 \Example ==========
  function parseTexFile(texFullPath, extractDir) {
    const raw = fs.readFileSync(texFullPath, 'utf8');
    const cleaned = stripComments(raw);
    const results = [];

    // 查找所有 \Practice 和 \Example 出现位置（按顺序）
    const positions = [];
    for (const cmd of ['\\Practice', '\\Example']) {
      let idx = 0;
      while ((idx = cleaned.indexOf(cmd, idx)) !== -1) {
        positions.push({ idx, cmd });
        idx += cmd.length;
      }
    }
    positions.sort((a, b) => a.idx - b.idx);

    for (const { idx, cmd } of positions) {
      const args = extractAllArgs(cleaned, idx, cmd.length);
      if (args.length < 2) continue;
      const [qContent, qAnswer] = args;
      try {
        const parsed = parseOneQuestion(qContent, qAnswer, texFullPath, extractDir);
        if (parsed) results.push(parsed);
      } catch (e) {
        console.error('解析单题失败:', e.message);
      }
    }

    return results;
  }

  // ========== API：上传 ZIP ==========
  // 注意：需要 multer 支持，这里用 require('multer') 动态加载
  let uploadZip;
  function getUploadZip() {
    if (uploadZip) return uploadZip;
    const multer = require('multer');
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(DATA_DIR, 'batch_uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const name = 'batch_' + Date.now() + '_' + Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, name);
      }
    });
    uploadZip = multer({ storage }).single('zipfile');
    return uploadZip;
  }

  app.post('/api/batch-import/upload-zip', (req, res) => {
    const uploader = getUploadZip();
    uploader(req, res, (err) => {
      if (err) return res.status(500).json({ error: '上传失败：' + err.message });
      if (!req.file) return res.status(400).json({ error: '请上传 ZIP 文件' });

      (async () => {
        try {
          const zipPath = req.file.path;
          const extractDir = path.join(DATA_DIR, 'batch_uploads', path.basename(zipPath, '.tmp') + '_extracted');
          if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
          fs.mkdirSync(extractDir, { recursive: true });

          const zipBuffer = fs.readFileSync(zipPath);
          const zip = new JSZip();
          await zip.loadAsync(zipBuffer);

          // 解压
          for (const [relPath, zipEntry] of Object.entries(zip.files)) {
            const fullPath = path.join(extractDir, relPath);
            if (zipEntry.dir) {
              if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
            } else {
              const parent = path.dirname(fullPath);
              if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
              const buf = await zipEntry.async('nodebuffer');
              fs.writeFileSync(fullPath, buf);
            }
          }

          // 扫描 .tex 文件
          const texFiles = [];
          function walk(dir) {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const it of items) {
              const fp = path.join(dir, it.name);
              if (it.isDirectory()) walk(fp);
              else if (it.name.endsWith('.tex')) texFiles.push({
                name: it.name,
                relativePath: path.relative(extractDir, fp),
                fullPath: fp,
              });
            }
          }
          walk(extractDir);

          // 保存 session
          const sessionId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          const sessionData = { extractDir, texFiles: texFiles.map(f => ({ name: f.name, relativePath: f.relativePath })) };
          fs.writeFileSync(path.join(SESSIONS_DIR, sessionId + '.json'), JSON.stringify(sessionData, null, 2), 'utf8');

          res.json({
            success: true,
            sessionId,
            texFiles: texFiles.map(f => ({ name: f.name, relativePath: f.relativePath }))
          });
        } catch (e) {
          console.error('批量上传失败:', e);
          res.status(500).json({ error: 'ZIP 解析失败：' + e.message });
        }
      })();
    });
  });

  // ========== API：解析指定 .tex 文件 ==========
  app.post('/api/batch-import/parse-tex', (req, res) => {
    try {
      const { sessionId, relativePath } = req.body;
      if (!sessionId || !relativePath) return res.status(400).json({ error: '缺少参数' });

      const sessionFile = path.join(SESSIONS_DIR, sessionId + '.json');
      if (!fs.existsSync(sessionFile)) return res.status(400).json({ error: '会话已过期，请重新上传' });

      const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      const texFullPath = path.join(session.extractDir, relativePath);
      if (!fs.existsSync(texFullPath)) return res.status(404).json({ error: '文件不存在' });

      const questions = parseTexFile(texFullPath, session.extractDir);

      // 加载题库，建立 contentHash 集合用于去重
      const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
      let existingHashes = new Set();
      try {
        const all = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
        existingHashes = new Set(all.map(q => q.contentHash).filter(Boolean));
      } catch {}

      // 给每题加临时 id、预览、去重标记
      let duplicateCount = 0;
      const withIds = questions.map((q, i) => {
        const hash = calcQuestionHash(q.content, q.analysis || '');
        const isDuplicate = existingHashes.has(hash);
        if (isDuplicate) duplicateCount++;
        return {
          ...q,
          contentHash: hash,
          isDuplicate,
          _tempId: 'temp_' + Date.now() + '_' + i,
          preview: (q.content || '').replace(/\\img\{[^}]+\}/g, '[图片]').slice(0, 120) + (q.content.length > 120 ? '...' : ''),
        };
      });

      res.json({ success: true, questions: withIds, duplicateCount });
    } catch (e) {
      console.error('解析 TEX 失败:', e);
      res.status(500).json({ error: '解析失败：' + e.message });
    }
  });

  // ========== API：批量保存题目 ==========
  app.post('/api/batch-import/save', (req, res) => {
    try {
      const { questions } = req.body;
      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: '没有要保存的题目' });
      }

      const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
      let all = [];
      try { all = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')); } catch { all = []; }

      const saved = [];
      const errors = [];

      for (const q of questions) {
        try {
          // 清理 content 中的 LaTeX 环境残留（\end{minipage}、孤立的 } 等）
          let cleanContent = (q.content || '').trim()
          if (q.type === '单选' || q.type === '多选') {
          // 删除 \item 行（选项已单独保存在 options 数组里，允许 \item 后无空格）
          cleanContent = cleanContent.replace(/\\item\s*[^\n]*/g, '')
            // 删除 minipage 环境残留
            cleanContent = cleanContent.replace(/\\begin\{minipage\}[\s\S]*?\\end\{minipage\}/g, '')
            cleanContent = cleanContent.replace(/\\begin\{minipage\}[\s\S]*$/g, '')
            cleanContent = cleanContent.replace(/\\end\{minipage\}/g, '')
            // 删除孤立的 }ge} 等碎片（通常是 \frac 或 minipage 损坏后的残留）
            cleanContent = cleanContent.replace(/\bge\}\s*/g, '')
            // 清除多余空行
            cleanContent = cleanContent.replace(/\n{3,}/g, '\n\n').trim()
          }

          const newQ = {
            id: 'q-' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            contentHash: calcQuestionHash(cleanContent || '', q.analysis || ''),
            title: q.title || '',
            content: cleanContent,
            answerContent: q.answerContent || '',
            analysis: q.analysis || '',
            options: q.options && q.options.length > 0 ? q.options : undefined,
            answer: q.answer || '',
            difficulty: q.difficulty || '中',
            type: q.type || '解答',
            grade: q.grade || '高一',
            categoryId: q.categoryId || '',
            categoryName: q.categoryName || '',
            tags: Array.isArray(q.tags) ? q.tags.map(t => typeof t === 'string' ? t.trim().replace(/[\n\r]+/g, '') : '').filter(t => t.length > 0) : [],
            source: q.source || '',
            images: q.images || {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          all.push(newQ);
          saved.push({ id: newQ.id, title: newQ.title });
        } catch (e) {
          errors.push({ title: q.title || '未知', error: e.message });
        }
      }

      fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(all, null, 2), 'utf8');
      res.json({ success: true, savedCount: saved.length, saved, errors });
    } catch (e) {
      console.error('批量保存失败:', e);
      res.status(500).json({ error: '保存失败：' + e.message });
    }
  });

  console.log('[batch-import] 批量录题 API 已加载');
};
