const https = require('https');
const http = require('http');
const fs = require('fs');

// 测试用公开 PDF URL（arXiv 论文）
const TEST_PDF_URL = 'https://arxiv.org/pdf/2103.15325.pdf';

// 从环境变量读取 Token（需要用 Bearer 前缀）
const TOKEN = process.env.MINERU_TOKEN;

if (!TOKEN) {
  console.error('错误：需要设置 MINERU_TOKEN 环境变量');
  console.error('用法：set MINERU_TOKEN=你的Token && node test_v4_simple.cjs');
  process.exit(1);
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const proto = options.port === 443 ? https : http;
    const req = proto.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { 
        try { resolve({ s: res.statusCode, j: JSON.parse(d), raw: d }); } 
        catch(e) { resolve({ s: res.statusCode, raw: d }); } 
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  console.log('=== MinerU v4 精准解析 API 测试 ===\n');
  console.log('使用公开 PDF URL:', TEST_PDF_URL, '\n');

  // Step1: 提交解析任务
  console.log('[1] 提交解析任务...');
  const body = JSON.stringify({
    url: TEST_PDF_URL,
    model_version: 'vlm',  // vlm = 视觉语言模型（高质量）
    is_json: true,           // 返回 JSON 格式
    address: '021'           // 上海机房
  });

  const r1 = await request({
    hostname: 'mineru.net',
    port: 443,
    path: '/api/v4/extract/task',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': `Bearer ${TOKEN}`
    }
  }, body);

  console.log('响应:', r1.raw.substring(0, 500));
  
  if (r1.j?.code !== 0 || !r1.j?.data?.task_id) {
    console.error('提交失败');
    return;
  }

  const taskId = r1.j.data.task_id;
  console.log(`Task ID: ${taskId}\n`);

  // Step2: 轮询任务状态
  console.log('[2] 等待解析完成...\n');
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const r2 = await request({
      hostname: 'mineru.net',
      port: 443,
      path: `/api/v4/extract/task/${taskId}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${TOKEN}` }
    });

    const state = r2.j?.data?.state;
    const percent = r2.j?.data?.percent || 0;
    
    process.stdout.write(`\r[${i+1}/90] ${state || '?'} ${percent}%   `);

    if (state === 'done') {
      console.log('\n\n=== 解析完成！ ===\n');
      console.log('完整响应:', r2.raw.substring(0, 2000));

      // 下载结果文件
      const fileList = r2.j.data.file_list || [];
      console.log(`\n文件数: ${fileList.length}\n`);

      for (const f of fileList) {
        console.log(`下载: ${f.filename}`);
        console.log(`URL: ${f.file_url.substring(0, 100)}...`);

        const fr = await request({
          hostname: new URL(f.file_url).hostname,
          port: 443,
          path: new URL(f.file_url).pathname + new URL(f.file_url).search,
          method: 'GET'
        });

        if (fr.raw && fr.raw.length > 10) {
          const outPath = `D:\\math-website\\v4_${f.filename}`;
          fs.writeFileSync(outPath, fr.raw);
          console.log(`已保存: ${outPath} (${fr.raw.length} bytes)\n`);

          // 预览内容
          if (f.filename.endsWith('.md') || f.filename.endsWith('.json')) {
            console.log('═══ 内容预览（前 3000 字符）═══');
            console.log(fr.raw.substring(0, 3000));
            console.log('\n═══ 结束 ═══\n');
          }
        }
      }
      return;
    }

    if (state === 'failed') {
      console.log('\n\n失败:', r2.raw);
      return;
    }
  }

  console.log('\n\n超时！');
}

run().catch(e => console.error('Error:', e));
