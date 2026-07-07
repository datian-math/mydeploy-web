const https = require("https");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const TOKEN = process.env.MINERU_TOKEN;
const PDF_PATH = "data/papers/paper_1781007241390.pdf";
const OUT_DIR = "mineru_v4_output";

const pdfBuf = fs.readFileSync(PDF_PATH);
console.log("PDF:", path.basename(PDF_PATH), (pdfBuf.length / 1024).toFixed(1) + "KB");

function api(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    var bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
    var hdrs = { "Authorization": "Bearer " + TOKEN };
    if (bodyStr) {
      hdrs["Content-Type"] = "application/json";
      hdrs["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }
    var req = https.request({ hostname: "mineru.net", path: apiPath, method: method, headers: hdrs },
      function(res) {
        var d = "";
        res.on("data", function(c) { d += c; });
        res.on("end", function() {
          try { resolve(JSON.parse(d)); } catch(e) { resolve(d); }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function putToOss(ossUrl, dataBuf) {
  return new Promise(function(resolve, reject) {
    var u = new URL(ossUrl);
    var req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "PUT",
      family: 4,
      timeout: 120000
    }, function(res) {
      var d = "";
      res.on("data", function(c) { d += c; });
      res.on("end", function() { resolve(d); });
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("oss timeout")); });
    req.write(dataBuf);
    req.end();
  });
}

function httpGet(url) {
  return new Promise(function(resolve, reject) {
    var u = new URL(url);
    var req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      family: 4,
      timeout: 120000
    }, function(res) {
      var chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() { resolve(Buffer.concat(chunks)); });
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("get timeout")); });
    req.end();
  });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ====== MAIN ======
async function run() {
  var t0 = Date.now();

  // Step 1: 获取上传签名 URL
  console.log("\n[1] 获取上传签名...");
  var r1 = await api("POST", "/api/v1/agent/parse/file", { file_name: path.basename(PDF_PATH) });
  if (!r1.data || r1.code !== 0) throw new Error("Step1失败: " + JSON.stringify(r1));
  var fileUrl = r1.data.file_url;
  console.log("  file_url:", fileUrl.substring(0, 70) + "...");

  // Step 2: PUT 上传到 OSS
  console.log("\n[2] 上传 PDF 到 OSS...");
  await putToOss(fileUrl, pdfBuf);
  console.log("  上传完成!");

  console.log("\n  等待15秒让系统检测文件...");
  await sleep(15000);

  // Step 3: 提交 v4 精准解析任务
  console.log("\n[3] 提交 v4 精准解析任务...");
  var r3 = await api("POST", "/api/v4/extract/task", {
    url: fileUrl,
    model_version: "vlm",
    enable_formula: true
  });
  if (!r3.data || r3.code !== 0) throw new Error("v4提交失败: " + JSON.stringify(r3));
  var taskId = r3.data.task_id;
  console.log("  v4 task_id:", taskId);

  // Step 4: 轮询状态
  console.log("\n[4] 轮询解析状态...");
  for (var i = 0; i < 90; i++) {
    await sleep(5000);
    var r4 = await api("GET", "/api/v4/extract/task/" + taskId);
    process.stdout.write("\r  [" + (i+1) + "] ");
    if (!r4 || !r4.data || typeof r4 === "string") { process.stdout.write("?"); continue; }
    var state = r4.data.state || "";
    var prog = r4.data.extract_progress || "";
    process.stdout.write("state=" + state + " progress=" + prog + "   ");
    if (state === "done") {
      console.log("\n  解析完成!");
      // Step 5
      var zipUrl = r4.data.full_zip_url || r4.data.zip_url;
      if (!zipUrl) {
        console.log("\n未找到 ZIP URL:", JSON.stringify(r4.data).substring(0, 400));
        return;
      }

      console.log("\n[5] 下载 ZIP...", zipUrl.substring(0, 60) + "...");
      fs.mkdirSync(OUT_DIR, { recursive: true });
      var zipData = await httpGet(zipUrl);
      var zipPath = path.join(OUT_DIR, "result.zip");
      fs.writeFileSync(zipPath, zipData);
      console.log("  ZIP:", (zipData.length / 1024).toFixed(1), "KB");

      // 解压
      console.log("  解压中...");
      var zip = new AdmZip(zipPath);
      zip.extractAllTo(OUT_DIR, true);

      // 列出文件
      function walk(dir, prefix) {
        var items = fs.readdirSync(dir);
        for (var j = 0; j < items.length; j++) {
          var fp = path.join(dir, items[j]);
          var st = fs.statSync(fp);
          if (st.isDirectory()) walk(fp, prefix + items[j] + "/");
          else console.log("   " + prefix + items[j], "(" + (st.size / 1024).toFixed(1) + "KB)");
        }
      }
      console.log("  文件列表:");
      walk(OUT_DIR, "");

      // 读 full.md
      var mdPath = path.join(OUT_DIR, "full", "full.md");
      if (fs.existsSync(mdPath)) {
        var md = fs.readFileSync(mdPath, "utf8");
        console.log("\n====== full.md 前1500字符 ======\n" + md.substring(0, 1500));
        console.log("\n====== 总长度: " + md.length + " 字符 ======");
      } else {
        console.log("\n未找到 full/full.md");
      }

      console.log("\n总耗时: " + ((Date.now() - t0) / 1000).toFixed(1) + " 秒");
      console.log("输出目录: " + OUT_DIR);
      return;

    }
    if (state === "failed") throw new Error("解析失败: " + (r4.data.err_msg || ""));
  }
  throw new Error("轮询超时（7.5分钟）");
}

run().catch(function(err) {
  console.error("\n失败:", err.message);
  process.exit(1);
});
