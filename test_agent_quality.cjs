const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function run() {
  console.log('=== MinerU Agent 解析质量测试 ===\n');
  
  const pdfBuf = fs.readFileSync(PDF_PATH);
  const fname = path.basename(PDF_PATH);
  console.log(`[1] PDF: ${fname} (${(pdfBuf.length/1024).toFixed(0)}KB)\n`);

  // Step 2
  console.log('[2] 申请上传 URL...');
  const body = JSON.stringify({ platform: '5GMevTEprXuRijQnFQeQ3Tqu5gM', url: '', file_name: fname });
  const r1 = await request({
    hostname:'mineru.net', port:443, path:'/api/v1/agent/parse/file',
    method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
  }, body);

  console.log('Response:', JSON.stringify(r1.j).substring(0,300));
  if (r1.j?.code !== 0 || !r1.j?.data) { console.error('失败:', r1.raw); return; }
  
  const { task_id, file_url } = r1.j.data;
  console.log(`Task ID: ${task_id}\n`);

  // Step 3
  console.log('[3] 上传 PDF 到 OSS...');
  const upStatus = await put(file_url, pdfBuf);
  console.log(`上传状态: ${upStatus}\n`);
  if (upStatus < 200 || upStatus > 299) { console.error('上传失败'); return; }

  // Step 4: 轮询
  console.log('[4] 等待解析完成...');
  for (let i=0; i<90; i++) {
    await new Promise(r => setTimeout(r, 5000));
    
    const r2 = await request({
      hostname:'mineru.net',port:443,
      path:`/api/v1/agent/parse/${task_id}`,
      method:'GET'
    });
    
    const st = r2.j?.data?.task_status || '?';
    const pct = r2.j?.data?.percent || 0;
    process.stdout.write(`\r[${i+1}/90] ${st} ${pct}%   `);

    if (st === 'done') { 
      console.log('\n\n=== 解析完成！ ===\n'); 
      const fl = r2.j.data.file_list || [];
      console.log(`生成文件数: ${fl.length}\n`);
      
      for (const f of fl) {
        console.log(`下载: ${f.filename} (${f.file_url.substring(0,80)}...)`);
        
        try {
          const fr = await request({
            hostname:new URL(f.file_url).hostname, port:443,
            path:new URL(f.file_url).pathname + new URL(f.file_url).search,
            method:'GET'
          });
          
          if (fr.raw && fr.raw.length > 10) {
            const outPath = path.join(__dirname, f.filename);
            fs.writeFileSync(outPath, fr.raw);
            
            // 也保存为 .md 方便查看
            const mdPath = path.join(__dirname, 'agent_preview.md');
            fs.writeFileSync(mdPath, fr.raw);
            
            console.log(`已保存 (${fr.raw.length} bytes): ${outPath}\n`);
            console.log('═════════ 内容预览（前 4000 字符）═════════');
            console.log(fr.raw.substring(0, 4000));
            console.log('\n═════════ 预览结束 ═════════\n');
          }
        } catch(e) {
          console.error('下载失败:', e.message);
        }
      }
      return;
    }
    if (st === 'failed') { console.log('\n\n失败:', JSON.stringify(r2.j?.data)); return; }
  }

  console.log('\n\n超时！');
}

run().catch(e => console.error(e));
