/**
 * test_mineru_v4.cjs — 使用 MinerU v4 精准解析 API（正确版本）
 * 流程：申请上传URL → PUT上传PDF → 轮询批量结果 → 下载ZIP
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const TOKEN = process.env.MINERU_TOKEN;
const PDF_PATH = path.join(__dirname, 'data', 'papers', 'paper_1781253061899.pdf');

if (!TOKEN) { console.error('❌ 请设置 MINERU_TOKEN 环境变量'); process.exit(1); }
if (!fs.existsSync(PDF_PATH)) { console.error('❌ 找不到 PDF:', PDF_PATH); process.exit(1); }

const pdfBuffer = fs.readFileSync(PDF_PATH);
console.log('PDF 大小:', pdfBuffer.length, 'bytes');

const outputDir = path.join(__dirname, 'mineru_v4_output');
fs.mkdirSync(outputDir, { recursive: true });

// ——— 工具 ———
function apiReq(path, method, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'mineru.net',
      path,
      method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json',
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d), raw: d }); }
        catch { resolve({ status: res.statusCode, data: null, raw: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ——— Step1: 申请批量上传 URL ———
async function step1_getUploadUrls() {
  console.log('\n[Step 1] 申请 v4 批量上传 URL...');
  const res = await apiReq('/api/v4/file-urls/batch', 'POST', {
    files: [{ name: path.basename(PDF_PATH) }],
    model_version: 'vlm',          // 视觉语言模型（更高精度）
    enable_formula: true,           // 数学公式识别
    enable_table: false,
  });

  console.log('  状态码:', res.status);
  console.log('  响应:', JSON.stringify(res.data).substring(0, 300));

  if (!res.data || res.data.code !== 0) {
    throw new Error('申请上传 URL 失败: ' + JSON.stringify(res.data));
  }

  const { batch_id, file_urls } = res.data.data;
  console.log('  batch_id:', batch_id);
  console.log('  file_url (上传用):', file_urls[0].substring(0, 80) + '...');

  return { batch_id, upload_url: file_urls[0] };
}

// ——— Step2: PUT 上传文件到 OSS ———
async function step2_uploadFile(uploadUrl) {
  console.log('\n[Step 2] PUT 上传 PDF 到 OSS...');

  await new Promise((resolve, reject) => {
    const req = https.request(uploadUrl, { method: 'PUT' }, res => {
      console.log('  OSS PUT 状态码:', res.statusCode);
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log('  OSS 响应:', d.substring(0, 100));
        resolve();
      });
    });
    req.on('error', reject);
    req.write(pdfBuffer);
    req.end();
  });

  console.log('  ✅ 上传完成，系统将自动开始解析...');
}

// ——— Step3: 轮询批量任务结果 ———
async function step3_pollBatch(batchId) {
  console.log('\n[Step 3] 轮询批量任务结果...');
  console.log('  batch_id:', batchId);

  let attempts = 0;
  while (attempts < 60) {
    await sleep(5000);

    const res = await apiReq(`/api/v4/extract-results/batch/${batchId}`, 'GET');

    if (!res.data || res.data.code !== 0) {
      console.log('  轮询响应异常:', res.raw.substring(0, 200));
      attempts++;
      continue;
    }

    const results = res.data.data;  // 数组，每个文件一个结果
    const r = results[0];
    const state = r.state;
    const percent = r.extract_progress || 0;

    console.log(`  轮询 #${attempts + 1}: state=${state}, progress=${percent}`);

    if (state === 'done') {
      console.log('  ✅ 解析完成！');
      return r;
    }
    if (state === 'failed' || state === 'error') {
      throw new Error('解析失败: ' + JSON.stringify(r));
    }

    attempts++;
  }
  throw new Error('轮询超时');
}

// ——— Step4: 下载并解压 ZIP ———
async function step4_downloadZip(zipUrl) {
  console.log('\n[Step 4] 下载 ZIP 包...');
  console.log('  ZIP URL 前缀:', zipUrl.substring(0, 80) + '...');

  const zipPath = path.join(outputDir, 'result.zip');
  const file = fs.createWriteStream(zipPath);

  await new Promise((resolve, reject) => {
    https.get(zipUrl, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // 处理重定向
        console.log('  重定向到:', res.headers.location);
        https.get(res.headers.location, res2 => {
          res2.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });

  console.log('  ZIP 已保存:', zipPath, '(', fs.statSync(zipPath).size, 'bytes )');

  // 解压
  console.log('  解压中...');
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(outputDir, true);

  const files = fs.readdirSync(outputDir);
  console.log('  解压内容:', files);

  // 读取 full.md
  const mdPath = path.join(outputDir, 'full', 'full.md');
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf8');
    console.log('\n  ——— full.md 前 800 字符 ———');
    console.log(md.substring(0, 800));
    console.log('\n  ——— full.md 总长度:', md.length, '字符 ———');
  }

  // 图片
  const imgDir = path.join(outputDir, 'images');
  if (fs.existsSync(imgDir)) {
    const imgs = fs.readdirSync(imgDir);
    console.log('\n  提取图片数:', imgs.length);
    imgs.forEach(f => console.log('    ', f));
  } else {
    console.log('\n  ⚠️ 未找到 images/ 目录（可能 PDF 无图片）');
  }

  return outputDir;
}

// ——— 主流程 ———
async function main() {
  try {
    // Step1: 申请上传 URL
    const { batch_id, upload_url } = await step1_getUploadUrls();

    // Step2: 上传文件
    await step2_uploadFile(upload_url);

    // 等待系统检测文件上传完成（通常需要 5-15 秒）
    console.log('\n  等待 15 秒让系统检测文件上传...');
    await sleep(15000);

    // Step3: 轮询
    const result = await step3_pollBatch(batch_id);

    // Step4: 下载解压
    const zipUrl = result.full_zip_url;
    if (!zipUrl) {
      console.log('⚠️ 未找到 ZIP URL，完整结果:', JSON.stringify(result).substring(0, 500));
      return;
    }
    await step4_downloadZip(zipUrl);

    console.log('\n🎉 MinerU v4 精准解析测试成功！');
    console.log('输出目录:', outputDir);
    console.log('\n请查看输出目录中的文件，特别是 full/full.md 和 images/ 目录');

  } catch (err) {
    console.error('\n❌ 测试失败:', err.message);
    console.error(err.stack);
  }
}

main();
