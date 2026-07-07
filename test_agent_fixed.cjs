const https = require('https');
const http = require('http');
const fs = require('fs');

const PDF_PATH = 'D:\\math-website\\data\\papers\\paper_1781007241390.pdf';

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

function put(url, buf) {
  return new Promise((resolve, reject) => {
    const uo = new URL(url);
    const proto = uo.protocol === 'https:' ? https : http;
    const req = proto.request({
      hostname: uo.hostname, port: uo.port || 443,
      path: uo.pathname + uo.search,
      method: 'PUT',
      headers: { 'Content-Length': buf.length },
      family: 4
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(buf); req.end();
  });
}

async function run() {
  console.log('=== MinerU Agent API 测试（修复版）===\n');
  
  const pdfBuf = fs.readFileSync(PDF_PATH);
  const fname = 'paper_1781007241390.pdf';
  console.log(`[1] PDF: ${fname} (${(pdfBuf.length/1024).toFixed(0)}KB)\n`);
  
  // Step2: 获取上传 URL
  console.log('[2] 获取上传 URL...');
  const body = JSON.stringify({ platform: '5GMevTEprXuRijQnFQeQ3Tqu5gM', url: '', file_name: fname });
  const r1 = await request({
    hostname:'mineru.net', port:443, path:'/api/v1/agent/parse/file',
    method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
  }, body);
  
  if (r1.j?.code !== 0) { console.error('失败:', r1.raw); return; }
  const taskId = r1.j.data.task_id;
  const fileUrl = r1.j.data.file_url;
  console.log(`Task ID: ${taskId}\n`);
  
  // Step3: 上传 PDF
  console.log('[3] 上传 PDF...');
  const upStatus = await put(fileUrl, pdfBuf);
  console.log(`上传状态: ${upStatus}\n`);
  if (upStatus < 200 || upStatus > 299) { console.error('上传失败'); return; }
  
  // Step4: 轮询（修复：用 state 不是 task_status）
  console.log('[4] 等待解析...\n');
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 5000));
    
    const r2 = await request({
      hostname:'mineru.net', port:443,
      path:`/api/v1/agent/parse/${taskId}`,
      method:'GET'
    });
    
    const state = r2.j?.data?.state;  // 修复：state 不是 task_status
    process.stdout.write(`\r[${i+1}/90] ${state || '?'}   `);
    
    if (state === 'done') {
      console.log('\n\n=== 解析完成！ ===\n');
      console.log('完整响应:', r2.raw.substring(0, 1000));
      
      // 下载 Markdown（从 markdown_url）
      const mdUrl = r2.j.data.markdown_url;
      if (mdUrl) {
        console.log(`\n下载 Markdown: ${mdUrl.substring(0, 80)}...`);
        const fr = await request({
          hostname: new URL(mdUrl).hostname, port: 443,
          path: new URL(mdUrl).pathname + new URL(mdUrl).search,
          method: 'GET'
        });
        
        if (fr.raw && fr.raw.length > 10) {
          const outPath = 'D:\\math-website\\agent_result.md';
          fs.writeFileSync(outPath, fr.raw);
          console.log(`已保存: ${outPath} (${fr.raw.length} bytes)\n`);
          
          console.log('═════════ 内容预览（前 5000 字符）═════════');
          console.log(fr.raw.substring(0, 5000));
          console.log('\n═════════ 预览结束 ═════════\n');
          
          // 分析质量
          console.log('=== 质量分析 ===');
          console.log(`- 总长度: ${fr.raw.length} 字符`);
          console.log(`- 包含 LaTeX: ${fr.raw.includes('$') ? '是' : '否'}`);
          console.log(`- 包含表格: ${fr.raw.includes('|') ? '是' : '否'}`);
          console.log(`- 包含图片引用: ${fr.raw.includes('![') ? '是' : '否'}`);
          console.log(`- 行数: ${fr.raw.split('\n').length}`);
        }
      } else {
        console.log('未找到 markdown_url');
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
