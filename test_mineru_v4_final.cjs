/**
 * test_mineru_v4_final.cjs — MinerU v4 精准解析完整测试（修复版）
 * 关键：必须显式设置 Content-Length
 * 流程：Agent预上传 → PUT文件 → v4提交任务 → 轮询 → 下载ZIP → 解压
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const TOKEN = process.env.MINERU_TOKEN;
const PDF_PATH = path.join(__dirname, 'data', 'papers', 'paper_1781253061899.pdf');
const outputDir = path.join(__dirname, 'mineru_v4_output');

if (!TOKEN) { console.error('❌ 请设置 MINERU_TOKEN'); process.exit(1); }
if (!fs.existsSync(PDF_PATH)) { console.error('❌ 找不到 PDF:', PDF_PATH); process.exit(1); }

const pdfBuffer = fs.readFileSync(PDF_PATH);
console.log('PDF:', path.basename(PDF_PATH), '(' + (pdfBuffer.length / 1024).toFixed(1) + 'KB)');
fs.mkdirSync(outputDir, { recursive: true });

// ——— 带正确头的 API 请求 ———
function apiReq(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : undefined;
    const options = {
      hostname: 'mineru.net',
      path: apiPath,
      method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body))
        } : {})
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d), raw: d }); }
        catch { resolve({ status: res.statusCode, json: null, raw: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ——— Step1: Agent 获取上传签名 URL ———
async function step1() {
  console.log('\n[Step1] 获取上传签名 URL...');
  const res = await apiReq('POST', '/api/v1/agent/parse/file', { file_name: path.basename(PDF_PATH) });
  if (!res.json || res.json.code !== 0) throw new Error('Step1 失败: ' + res.raw);

  const { task_id: agentTaskId, file_url } = res.json.data;
  console.log('  ✅ agent_task_id:', agentTaskId);
  console.log('  file_url:', file_url.substring(0, 70) + '...');
  return { agentTaskId, file_url };
}

// ——— Step2: PUT 上传 PDF 到 OSS ———
async function step2(fileUrl) {
  console.log('\n[Step2] 上传 PDF 到 OSS...');
  await new Promise((resolve, reject) => {
    const urlObj = new URL(fileUrl);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'PUT',
      family: 4,          // 关键：强制 IPv4
      timeout: 120000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log('  OSS 状态:', res.statusCode, d.substring(0, 80));
        resolve();
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OSS PUT timeout')); });
    req.write(pdfBuffer);
    req.end();
  });
  console.log('  ✅ 文件已上传，等待系统检测...');
  await sleep(10000);  // 等10秒让系统检测到文件
}

// ——— Step3: 提交 v4 精准解析任务 ———
async function step3(fileUrl) {
  console.log('\n[Step3] 提交 v4 精准解析任务...');
  const res = await apiReq('POST', '/api/v4/extract/task', {
    url: fileUrl,
    model_version: 'vlm',
    enable_formula: true,
    enable_table: true,
  });
  console.log('  响应:', res.raw.substring(0, 400));
  if (!res.json || res.json.code !== 0) throw new Error('Step3 失败: ' + res.raw);

  const taskId = res.json.data.task_id || res.json.data.task_id;
  console.log('  ✅ v4 task_id:', taskId);
  return taskId;
}

// ——— Step4: 轮询任务状态 ———
async function step4(taskId) {
  console.log('\n[Step4] 轮询任务状态...');
  for (let i = 0; i < 72; i++) {  // 最多等6分钟
    await sleep(5000);
    const res = await apiReq('GET', `/api/v4/extract/task/${taskId}`);
    if (!res.json) continue;

    const data = res.json.data;
    const state = data.state;
    const progress = data.extract_progress || data.percent || '?';

    console.log(`  [${i+1}] state=${state} progress=${progress}`);

    if (state === 'done') {
      console.log('  ✅ 解析完成！');
      return data;
    }
    if (state === 'failed' || state === 'error' || data.err_msg) {
      throw new Error(`解析失败: ${data.err_msg || JSON.stringify(data).substring(0, 200)}`);
    }
  }
  throw new Error('轮询超时（6分钟）');
}

// ——— Step5: 下载 ZIP 并解压 ———
async function step5(zipUrl) {
  console.log('\n[Step5] 下载 ZIP:', zipUrl.substring(0, 70) + '...');

  const zipPath = path.join(outputDir, 'result.zip');
  const file = fs.createWriteStream(zipPath);

  await new Promise((resolve, reject) => {
    function tryDownload(url) {
      const urlObj = new URL(url);
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        family: 4,          // 强制 IPv4
        timeout: 120000,
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          console.log('  重定向 ->', res.headers.location ? res.headers.location.substring(0, 60) : '');
          tryDownload(res.headers.location); return;
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject).on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
      req.end();
    }
    tryDownload(zipUrl);
  });

  console.log('  ZIP 大小:', fs.statSync(zipPath).size, 'bytes');

  // 解压
  console.log('  解压中...');
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(outputDir, true);

  const files = fs.readdirSync(outputDir);
  console.log('  解压内容:', files.join(', '));

  // 读 full.md
  const mdPath = path.join(outputDir, 'full', 'full.md');
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf8');
    console.log('\n═══ full.md 前1000字符 ═══');
    console.log(md.substring(0, 1000));
    console.log('═══ 总长度:', md.length, '字符 ═══');
  } else {
    console.log('\n⚠️ 未找到 full.md');
    // 查找所有 .md 文件
    const allFiles = [];
    function walk(dir) {
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (stat.isDirectory()) walk(fp);
        else allFiles.push({ name: f, size: stat.size, path: fp });
      }
    }
    walk(outputDir);
    allFiles.sort((a, b) => b.size - a.size);
    console.log('  所有文件（按大小排序）:');
    allFiles.forEach(f => console.log(`    ${(f.size/1024).toFixed(1)}KB ${f.name}`));
  }

  // 图片目录
  const imgDirs = ['images', 'figures', 'imgs', 'pictures'];
  for (const id of imgDirs) {
    const ip = path.join(outputDir, id);
    if (fs.existsSync(ip)) {
      const imgs = fs.readdirSync(ip);
      console.log('\n📷 图片数 (' + id + '/):', imgs.length);
      imgs.slice(0, 10).forEach(f => console.log('   ', f));
    }
  }

  return outputDir;
}

// ——— 主流程 ———
async function main() {
  const start = Date.now();
  try {
    const { fileUrl } = await step1();
    await step2(fileUrl);
    
    // 用 fileUrl 提交 v4 任务
    const taskId = await step3(fileUrl);
    const result = await step4(taskId);
    
    const zipUrl = result.full_zip_url || result.zip_url;
    if (zipUrl) {
      await step5(zipUrl);
    } else {
      console.log('\n⚠️ 未找到 ZIP URL。完整结果:');
      console.log(JSON.stringify(result, null, 2).substring(0, 2000));
    }

    console.log('\n✨ 总耗时:', ((Date.now() - start) / 1000).toFixed(1), '秒');
    console.log('输出目录:', outputDir);

  } catch (err) {
    console.error('\n❌ 失败:', err.message);
    console.error(err.stack);
  }
}
main();
