// MinerU Agent 轻量解析 API 测试脚本
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MINERU_BASE = 'https://mineru.net';

// 参数
const PDF_FILE = process.argv[2] || 'data/papers/paper_1781326510761.pdf';
const OUTPUT_DIR = path.resolve('mineru_test_output');

// HTTP 请求工具
function request(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const reqOpts = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: opts.headers || {},
      timeout: 30000
    };
    const req = mod.request(reqOpts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (opts.body) {
      const bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      req.setHeader('Content-Length', Buffer.byteLength(bodyStr));
      req.write(bodyStr);
    }
    req.end();
  });
}

// PUT 文件上传
function putFile(uploadUrl, fileBuffer) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: 'PUT',
      headers: { 'Content-Length': fileBuffer.length },
      timeout: 60000
    };
    const req = mod.request(reqOpts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Upload timeout')); });
    req.end(fileBuffer);
  });
}

// 下载文件
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, destPath).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, Buffer.concat(chunks));
        resolve(destPath);
      });
    }).on('error', reject);
  });
}

async function main() {
  const pdfPath = path.resolve(PDF_FILE);
  if (!fs.existsSync(pdfPath)) {
    console.error('PDF not found:', pdfPath);
    process.exit(1);
  }

  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfName = path.basename(pdfPath);
  console.log(`📄 PDF: ${pdfName} (${(pdfBuffer.length/1024).toFixed(1)} KB)`);

  // Step 1: 申请上传链接 (Agent 轻量解析)
  console.log('\n📤 Step 1: 申请文件上传链接...');
  const body = {
    file_name: pdfName,
    language: 'ch',
    enable_formula: true,
    enable_table: true,
    is_ocr: false
  };
  const bodyStr = JSON.stringify(body);
  console.log('  请求体:', bodyStr);
  const fileRes = await request('POST', `${MINERU_BASE}/api/v1/agent/parse/file`, {
    headers: { 'Content-Type': 'application/json' },
    body: bodyStr
  });

  console.log('  响应:', JSON.stringify(fileRes.body, null, 2).substring(0, 500));

  if (fileRes.body.code !== 0) {
    console.error('❌ 申请上传链接失败:', fileRes.body.msg || fileRes.body);
    process.exit(1);
  }

  const { task_id, file_url } = fileRes.body.data;
  console.log('  task_id:', task_id);
  console.log('  file_url:', file_url?.substring(0, 80) + '...');

  // Step 2: PUT 文件上传
  console.log('\n📤 Step 2: 上传文件到 OSS...');
  const upRes = await putFile(file_url, pdfBuffer);
  console.log('  上传状态:', upRes.status, upRes.body?.substring(0, 100) || '');
  if (upRes.status !== 200 && upRes.status !== 204 && upRes.status !== 201) {
    console.error(`❌ 上传失败 (HTTP ${upRes.status})`);
    process.exit(1);
  }
  console.log('  ✅ 上传成功');

  // Step 3: 轮询结果
  console.log('\n⏳ Step 3: 轮询解析状态...');
  let result = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusRes = await request('GET', `${MINERU_BASE}/api/v1/agent/parse/${task_id}`);
    const state = statusRes.body?.data?.state;
    const progress = statusRes.body?.data?.progress;
    console.log(`  [${i+1}] state=${state} progress=${progress || '?'}`);

    if (state === 'done') {
      result = statusRes.body.data;
      break;
    }
    if (state === 'failed') {
      console.error('❌ 解析失败:', JSON.stringify(statusRes.body));
      process.exit(1);
    }
  }

  if (!result) {
    console.error('❌ 解析超时');
    process.exit(1);
  }

  // Step 4: 下载结果
  console.log('\n✅ 解析完成！');
  console.log('  结果:', JSON.stringify(result, null, 2).substring(0, 1000));

  if (result.markdown_url) {
    const mdPath = path.join(OUTPUT_DIR, pdfName.replace('.pdf', '') + '.md');
    console.log(`\n📥 下载 Markdown: ${result.markdown_url}`);
    await download(result.markdown_url, mdPath);
    console.log(`   保存到: ${mdPath}`);

    // 显示前 100 行
    const mdContent = fs.readFileSync(mdPath, 'utf8');
    const lines = mdContent.split('\n');
    console.log(`\n📝 Markdown 内容 (前 ${Math.min(100, lines.length)} 行 / 共 ${lines.length} 行):`);
    console.log('─'.repeat(60));
    lines.slice(0, 100).forEach(l => console.log(l));
    if (lines.length > 100) console.log(`... (${lines.length - 100} 行省略)`);
  }

  console.log('\n🎉 测试完成！');
}

main().catch(e => {
  console.error('💥 错误:', e);
  process.exit(1);
});
