const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PDF_PATH = 'D:\\math-website\\data\\papers\\paper_1781007241390.pdf';

// 通用 HTTP 请求封装
function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const proto = options.port === 443 ? https : http;
    const req = proto.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 通用 PUT 上传（支持 family: 4）
function httpPut(url, content, contentType, family = 4) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'PUT',
      headers: {
        'Content-Length': Buffer.byteLength(content),
        'Content-Type': contentType
      },
      family: family
    };
    const proto = urlObj.protocol === 'https:' ? https : http;
    const req = proto.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    if (Buffer.isBuffer(content)) {
      req.write(content);
    } else {
      req.end(content);
    }
  });
}

async function testAgentAPI() {
  console.log('=== MinerU Agent API 测试（无需认证）===\n');
  
  // 1. 读取 PDF 文件
  console.log('[1] 读取 PDF 文件...');
  if (!fs.existsSync(PDF_PATH)) {
    console.error('PDF 文件不存在:', PDF_PATH);
    return;
  }
  const pdfBuffer = fs.readFileSync(PDF_PATH);
  const filename = path.basename(PDF_PATH);
  console.log(`文件: ${filename}, 大小: ${(pdfBuffer.length / 1024).toFixed(2)} KB\n`);
  
  // 2. 调用 Agent API 获取上传 URL（无需认证！）
  console.log('[2] 调用 Agent API 获取上传 URL...');
  const agentBody = JSON.stringify({
    platform: '5GMevTEprXuRijQnFQeQ3Tqu5gM',
    url: '',
    file_name: filename  // 添加文件名
  });
  
  const agentOptions = {
    hostname: 'mineru.net',
    port: 443,
    path: '/api/v1/agent/parse/file',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(agentBody)
      // 注意：Agent API 无需认证！
    }
  };
  
  const agentResult = await makeRequest(agentOptions, agentBody);
  console.log('Agent API 响应:', JSON.stringify(agentResult.data, null, 2));
  
  if (!agentResult.data || !agentResult.data.data) {
    console.error('Agent API 调用失败:', agentResult.data?.msg || '未知错误');
    return;
  }
  
  const { task_id, file_url } = agentResult.data.data;
  console.log(`Task ID: ${task_id}`);
  console.log(`Upload URL: ${file_url}\n`);
  
  // 3. 上传 PDF 到 OSS（不设置 Content-Type，避免 OSS 拒绝）
  console.log('[3] 上传 PDF 到 OSS...');
  const uploadUrlObj = new URL(file_url);
  const uploadOptions = {
    hostname: uploadUrlObj.hostname,
    port: uploadUrlObj.port || 443,
    path: uploadUrlObj.pathname + uploadUrlObj.search,
    method: 'PUT',
    headers: {
      'Content-Length': Buffer.byteLength(pdfBuffer)
      // 不设置 Content-Type，让 OSS 自动检测
    },
    family: 4
  };
  
  const uploadProto = uploadUrlObj.protocol === 'https:' ? https : http;
  const uploadResult = await new Promise((resolve, reject) => {
    const req = uploadProto.request(uploadOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(pdfBuffer);
    req.end();
  });
  
  console.log(`上传状态: ${uploadResult.status}`);
  if (uploadResult.data) {
    console.log(`上传响应: ${uploadResult.data.substring(0, 200)}\n`);
  }
  
  if (uploadResult.status !== 200) {
    console.error('上传失败');
    return;
  }
  
  // 4. 轮询任务状态
  console.log('[4] 轮询任务状态...');
  const maxAttempts = 60;
  const interval = 5000; // 5秒
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, interval));
    
    const statusOptions = {
      hostname: 'mineru.net',
      port: 443,
      path: `/api/v1/agent/parse/${task_id}`,
      method: 'GET'
      // 注意：Agent API 无需认证！
    };
    
    const statusResult = await makeRequest(statusOptions);
    const status = statusResult.data;
    
    const progress = status?.data?.percent || 0;
    const taskStatus = status?.data?.task_status || 'unknown';
    console.log(`[${i + 1}/${maxAttempts}] 状态: ${taskStatus}, 进度: ${progress}%`);
    
    if (taskStatus === 'done') {
      console.log('\n解析完成！');
      console.log('结果:', JSON.stringify(status.data, null, 2));
      
      // 5. 下载 Markdown 文件
      if (status.data.file_list && status.data.file_list.length > 0) {
        console.log('\n[5] 下载 Markdown 文件...');
        for (const fileInfo of status.data.file_list) {
          console.log(`文件: ${fileInfo.filename}, URL: ${fileInfo.file_url}`);
          
          // 下载文件
          const fileUrlObj = new URL(fileInfo.file_url);
          const fileOptions = {
            hostname: fileUrlObj.hostname,
            port: fileUrlObj.port || 443,
            path: fileUrlObj.pathname + fileUrlObj.search,
            method: 'GET'
          };
          
          const fileResult = await makeRequest(fileOptions);
          if (fileResult.raw) {
            const outputPath = path.join(__dirname, fileInfo.filename);
            fs.writeFileSync(outputPath, fileResult.raw);
            console.log(`已保存到: ${outputPath}\n`);
            
            // 显示前 3000 字符内容
            console.log('=== Markdown 内容预览 ===');
            console.log(fileResult.raw.substring(0, 3000));
            console.log('\n...(truncated)...\n');
            
            // 保存到文件，方便查看
            const fullOutputPath = path.join(__dirname, 'agent_result.md');
            fs.writeFileSync(fullOutputPath, fileResult.raw);
            console.log(`完整结果已保存到: ${fullOutputPath}`);
          }
        }
      }
      
      break;
    } else if (taskStatus === 'failed') {
      console.error('解析失败:', status.data.error_msg);
      break;
    }
  }
  
  console.log('\n=== 测试完成 ===');
}

testAgentAPI().catch(console.error);
