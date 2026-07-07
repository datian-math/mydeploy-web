/**
 * test_mineru_full.cjs — 测试 MinerU v4 精准解析完整流程
 * 步骤：Agent上传PDF → 获取file_url → v4提交任务 → 轮询 → 下载ZIP → 解压
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const TOKEN = process.env.MINERU_TOKEN || 'YOUR_TOKEN_HERE';
const PDF_PATH = path.join(__dirname, 'data', 'papers', 'paper_1781253061899.pdf');

// ——— 工具函数 ———
function httpsReq(options, body) {
  return new Promise((resolve, reject) => {
    const proto = options.port === 443 ? https : http;
    const req = proto.request(options, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const json = JSON.parse(raw);
          resolve({ status: res.statusCode, headers: res.headers, data: json, raw });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data: null, raw });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ——— Step 1: Agent 轻量版上传 PDF，获取 file_url ———
async function uploadToAgent(pdfBuffer) {
  console.log('\n[Step 1] Agent 上传 PDF...');

  // 1a. 获取预上传 URL
  const fileName = `test_${Date.now()}.pdf`;
  const preReq = httpsReq({
    hostname: 'mineru.net',
    path: '/api/v1/file/upload/preupload',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
    }
  }, JSON.stringify({ file_name: fileName, size: pdfBuffer.length }));

  const preRes = await preReq;
  console.log('  预上传响应:', JSON.stringify(preRes.data).substring(0, 200));

  if (!preRes.data || preRes.data.code !== 0) {
    throw new Error('预上传失败: ' + JSON.stringify(preRes.data));
  }

  const { upload_url, file_url } = preRes.data.data;
  console.log('  upload_url:', upload_url ? upload_url.substring(0, 60) + '...' : 'MISSING');
  console.log('  file_url:', file_url);

  // 1b. PUT 上传文件到 OSS
  console.log('[Step 1b] PUT 上传到 OSS...');
  await new Promise((resolve, reject) => {
    const req = https.request(upload_url, { method: 'PUT' }, res => {
      console.log('  OSS PUT 状态码:', res.statusCode);
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { console.log('  OSS 响应:', d.substring(0, 100)); resolve(); });
    });
    req.on('error', reject);
    req.write(pdfBuffer);
    req.end();
  });

  console.log('[Step 1c] 确认 file_url 可用...');
  // 用 file_url 提交给 Agent API 验证
  const agentRes = await httpsReq({
    hostname: 'mineru.net',
    path: '/api/v1/agent/parse/file',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
    }
  }, JSON.stringify({ file_name: fileName, file_url }));

  console.log('  Agent 响应:', JSON.stringify(agentRes.data).substring(0, 200));
  if (!agentRes.data || agentRes.data.code !== 0) {
    throw new Error('Agent 提交失败: ' + JSON.stringify(agentRes.data));
  }

  const agentTaskId = agentRes.data.data.task_id;
  console.log('  Agent task_id:', agentTaskId);

  return { file_url, agentTaskId, fileName };
}

// ——— Step 2: 提交 v4 精准解析任务 ———
async function submitV4Task(fileUrl) {
  console.log('\n[Step 2] 提交 v4 精准解析任务...');
  console.log('  file_url:', fileUrl);

  const res = await httpsReq({
    hostname: 'mineru.net',
    path: '/api/v4/extract/task',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
    }
  }, JSON.stringify({
    url: fileUrl,
    enable_formula: true,
    // language: 'zh',  // 中文优先
  }));

  console.log('  v4 响应:', JSON.stringify(res.data));
  if (!res.data || res.data.code !== 0) {
    throw new Error('v4 提交失败: ' + JSON.stringify(res.data));
  }

  const taskId = res.data.data.task_id;
  console.log('  v4 task_id:', taskId);
  return taskId;
}

// ——— Step 3: 轮询任务状态 ———
async function pollV4Task(taskId) {
  console.log('\n[Step 3] 轮询任务状态...');

  let attempts = 0;
  while (attempts < 60) {  // 最多等 5 分钟
    await sleep(5000);

    const res = await httpsReq({
      hostname: 'mineru.net',
      path: `/api/v4/extract/get?task_id=${taskId}`,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + TOKEN }
    });

    const state = res.data?.data?.state;
    const percent = res.data?.data?.percent || 0;
    console.log(`  轮询 #${attempts + 1}: state=${state}, percent=${percent}%`);

    if (state === 'done') {
      console.log('  ✅ 任务完成！');
      return res.data.data;
    }
    if (state === 'error' || state === 'failed') {
      throw new Error('任务失败: ' + JSON.stringify(res.data));
    }

    attempts++;
  }
  throw new Error('轮询超时');
}

// ——— Step 4: 下载并解压 ZIP ———
async function downloadAndExtract(zipUrl, outputDir) {
  console.log('\n[Step 4] 下载 ZIP 包...');
  console.log('  ZIP URL:', zipUrl.substring(0, 80) + '...');

  // 用 https 下载
  const zipPath = path.join(outputDir, 'mineru_result.zip');
  const file = fs.createWriteStream(zipPath);

  await new Promise((resolve, reject) => {
    const req = https.get(zipUrl, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', reject);
  });

  console.log('  ZIP 已保存到:', zipPath);
  console.log('  ZIP 大小:', fs.statSync(zipPath).size, 'bytes');

  // 解压
  console.log('  解压中...');
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(outputDir, true);

  // 列出解压后的文件
  const files = fs.readdirSync(outputDir);
  console.log('  解压内容:', files);

  // 找 full.md
  const fullMdPath = path.join(outputDir, 'full', 'full.md');
  if (fs.existsSync(fullMdPath)) {
    const md = fs.readFileSync(fullMdPath, 'utf8');
    console.log('\n  —— full.md 前500字符 ——');
    console.log(md.substring(0, 500));
    console.log('  —— full.md 长度:', md.length, '字符 ——');
  }

  // 列出图片
  const imgDir = path.join(outputDir, 'images');
  if (fs.existsSync(imgDir)) {
    const imgs = fs.readdirSync(imgDir);
    console.log('\n  提取的图片数:', imgs.length);
    imgs.slice(0, 5).forEach(f => console.log('    ', f));
  } else {
    console.log('\n  ⚠️ 未找到 images/ 目录');
  }

  return { outputDir, zipPath };
}

// ——— 主流程 ———
async function main() {
  if (!fs.existsSync(PDF_PATH)) {
    console.error('❌ 找不到测试 PDF:', PDF_PATH);
    console.error('请放一个 test5.pdf 到 math-website/ 目录');
    process.exit(1);
  }

  const pdfBuffer = fs.readFileSync(PDF_PATH);
  console.log('PDF 大小:', pdfBuffer.length, 'bytes');

  const outputDir = path.join(__dirname, 'mineru_test_output');
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    // Step 1: 上传
    const { file_url } = await uploadToAgent(pdfBuffer);

    // Step 2: 提交 v4 任务
    const v4TaskId = await submitV4Task(file_url);

    // Step 3: 轮询
    const result = await pollV4Task(v4TaskId);

    // Step 4: 下载解压
    const zipUrl = result.full_zip_url || result.zip_url;
    if (!zipUrl) {
      console.log('⚠️ 未找到 ZIP URL，完整响应:', JSON.stringify(result));
      return;
    }
    await downloadAndExtract(zipUrl, outputDir);

    console.log('\n🎉 完整流程测试成功！');
    console.log('输出目录:', outputDir);

  } catch (err) {
    console.error('\n❌ 测试失败:', err.message);
    console.error(err.stack);
  }
}

main();
