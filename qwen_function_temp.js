
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
  const questionsLatex = result.questions_latex || '';
  const answers = result.answers || {};
  const images = result.images || [];  // PDF 嵌入图片路径列表
  const pageImages = result.page_images || [];  // 逐页截图路径列表

  console.log(`[QwenVLM] ${taskId}: 题目 LaTeX ${questionsLatex.length} 字符, 答案 ${Object.keys(answers).length} 项, 图片 ${images.length} 张`);

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

  // 6. 答案处理（如果有）
  if (answers.raw) {
    console.log(`[QwenVLM] ${taskId}: 答案已提取（${answers.raw.length} 字符），将在切题后关联`);
    // 把答案写入 taskDir/answers.md 供 processQuestionsFromMarkdown 读取
    fs.writeFileSync(path.join(taskDir, 'answers.md'), answers.raw, 'utf8');
  }

  // 7. 调用统一的"切题 + 替换图片 + LLM 结构化 + 入库"流程
  await processQuestionsFromMarkdown(
    taskId, mdContent, imgMapping, taskDir, defaults,
    '[QwenVLM]'
  );
}
