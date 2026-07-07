// Re-parse task_1781461375803 using fixed extractOptionsFromText
// Run: node scripts/reparse_task.js

const fs = require('fs');
const path = require('path');

// ========== Inline required functions from server.cjs ==========
function cleanDoc2xContent(md) {
  let cleaned = md;
  // Remove HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');
  // Remove figureText comments
  cleaned = cleaned.replace(/<!--\s*figureText:[\s\S]*?-->/g, '');
  // Normalize line endings
  cleaned = cleaned.replace(/\r\n/g, '\n');
  // Remove multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

function normalizeMathDelimiters(text) {
  // Convert \( ... \) to $ ... $ for consistency
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$');
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$1$');
  return text;
}

function extractImageRefs(text) {
  const images = [];
  const imgRe = /<img\s+src="([^"]+)"\/?>/g;
  let m;
  while ((m = imgRe.exec(text)) !== null) {
    images.push(m[1]);
  }
  const noImgText = text.replace(/<img\s+[^>]+\/>/g, '');
  return { text: noImgText, images };
}

function detectTypeFromTitle(title) {
  if (!title) return null;
  const t = title.replace(/[\s#（）()]/g, '');
  if (/多选/.test(t)) return '多选';
  if (/单选|选择/.test(t) && !/多选/.test(t)) return '单选';
  if (/填空/.test(t)) return '填空';
  if (/解答|大题|计算|证明|综合/.test(t)) return '解答';
  return null;
}

function cleanOptionText(opt) {
  return opt.trim()
    .replace(/^[A-D][\.．\uFF0E)]\s*/, '')  // 去掉前导 "A. "
    .replace(/\s{2,}/g, ' ')               // 多余空格
    .trim();
}

// The NEW extractOptionsFromText (fixed version)
function extractOptionsFromText(body) {
  const options = [];
  let cleanBody = body;

  const lineSepRe = /^\s*([A-D])[\.．\uFF0E)]\s*(.+)$/gm;
  const lineOpts = [];
  let lm;
  while ((lm = lineSepRe.exec(body)) !== null) {
    lineOpts.push({ label: lm[1], text: lm[2].trim(), index: lm.index, full: lm[0] });
  }

  if (lineOpts.length >= 2) {
    const allSingle = lineOpts.every(function(o) { return !/[A-D][\.．\uFF0E)]/.test(o.text.substring(0, 80)); });
    if (allSingle) {
      lineOpts.forEach(function(o) { options.push(o.label + '. ' + o.text); });
      cleanBody = body.substring(0, lineOpts[0].index).trim().replace(/[\（(][\s]*$/g, '') + '（ ）';
      return { body: cleanBody, options: options };
    }
  }

  if (lineOpts.length >= 1) {
    var optBlockText = '';
    var optStartIdx = lineOpts[0].index;
    for (var i = 0; i < lineOpts.length; i++) {
      optBlockText += (i > 0 ? '\n' : '') + lineOpts[i].full.trim();
      if (i < lineOpts.length - 1) {
        var gap = body.substring(lineOpts[i].index + lineOpts[i].full.length, lineOpts[i + 1].index);
        if (gap.split('\n').length > 3) break;
      }
    }
    // Position-based scanning: find ALL A.-D. marker positions, then slice between them
    var markerRe = /([A-D])[\.．\uFF0E)]/g;
    var positions = [];
    var pm;
    while ((pm = markerRe.exec(optBlockText)) !== null) {
      // Skip markers inside LaTeX commands like \mathrm{B}. or \text{A}.
      var charBefore = pm.index > 0 ? optBlockText[pm.index - 1] : '';
      if (charBefore === '{' || charBefore === '\\') continue;
      positions.push({ label: pm[1], absPos: pm.index, markLen: pm[0].length });
    }
    if (positions.length >= 2) {
      var slicedOpts = [];
      for (var j = 0; j < positions.length; j++) {
        var txtStart = positions[j].absPos + positions[j].markLen;
        var txtEnd = (j + 1 < positions.length) ? positions[j + 1].absPos : optBlockText.length;
        var optTxt = optBlockText.substring(txtStart, txtEnd).trim()
          .replace(/^[A-D][\.．\uFF0E)]\s*/, '');
        if (optTxt && optTxt.length > 0 && !/^[A-D][\.．\uFF0E)]\s*$/.test(optTxt)) {
          slicedOpts.push(positions[j].label + '. ' + optTxt);
        }
      }
      if (slicedOpts.length >= 2) {
        options.push.apply(options, slicedOpts);
        cleanBody = body.substring(0, optStartIdx).trim().replace(/[\（(][\s]*$/g, '') + '（ ）';
        return { body: cleanBody, options: options };
      }
    }
  }

  var inlineRe = /(?:^|\s)([A-D])[\.．\uFF0E)]\s*(.+?)(?=\s+(?:[A-D][\.．\uFF0E])|$)/g;
  var sm;
  while ((sm = inlineRe.exec(body)) !== null) {
    if (sm[2].trim()) options.push(sm[1] + '. ' + sm[2].trim().replace(/^[A-D][\.．\uFF0E)]\s+/, ''));
  }
  if (options.length >= 2) {
    var firstMatch = body.match(/(?:^|\s)([A-D])[\.．\uFF0E)]/);
    if (firstMatch && firstMatch.index > 0) {
      cleanBody = body.substring(0, firstMatch.index).trim().replace(/[\（(][\s]*$/g, '') + '（ ）';
    } else {
      cleanBody = body.replace(/\s*[A-D][\.．\uFF0E)].*$/, '').trim() + '（ ）';
    }
    return { body: cleanBody, options: options };
  }

  return { body: cleanBody, options: options };
}

function extractQuestionBodies(text) {
  const lines = text.split('\n');
  let startFrom = 0;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const l = lines[i].trim();
    if (!l || /^(?:一、|二、|三、|四、|五、|六、)/.test(l) ||
        /^(?:第[IVX]+卷|选择题|非选择题|填空题|解答题)/.test(l) ||
        /^(?:每小题|本题|每题|共\d+题)/.test(l) ||
        /^(?:在每小题|请将答案|注意事项)/.test(l)) {
      startFrom = i + 1;
    } else if (/^\d{1,2}[\.、．]/.test(l)) {
      break;
    }
  }
  text = lines.slice(startFrom).join('\n');

  const splitRe = /(?:\n|^)\s*(\d{1,2})[\.、．]\s*/g;
  const bodies = [];
  let lastIdx = 0, lastNum = 0;
  let m;
  while ((m = splitRe.exec(text)) !== null) {
    if (lastIdx > 0 && m.index > lastIdx) {
      bodies.push({ number: lastNum, body: text.substring(lastIdx, m.index).trim(), type: '单选' });
    }
    lastIdx = m.index + m[0].length;
    lastNum = parseInt(m[1]);
  }
  if (lastIdx > 0 && lastIdx < text.length) {
    bodies.push({ number: lastNum, body: text.substring(lastIdx).trim(), type: '单选' });
  }

  // Image drift fix
  for (let i = 0; i < bodies.length - 1; i++) {
    const current = bodies[i];
    const nextBody = bodies[i + 1];
    const trailingImgsMatch = current.body.match(/((?:\s*<img\s+src="[^"]+"\/>\s*\n?)+)$/);
    if (trailingImgsMatch) {
      const beforeImg = current.body.substring(0, current.body.length - trailingImgsMatch[0].length).trim();
      const nextStartsWithRutu = /如图/.test(nextBody.body.substring(0, 20));
      if (nextStartsWithRutu || beforeImg.length < 30) {
        bodies[i + 1].body = trailingImgsMatch[1].trim() + '\n' + nextBody.body;
        current.body = beforeImg;
      }
    }
  }
  if (bodies.length > 0) {
    const first = bodies[0];
    const leadingImgs = first.body.match(/^((?:\s*<img\s+src="[^"]+"\/>\s*\n?)+)/);
    if (leadingImgs) {
      const afterImg = first.body.substring(leadingImgs[0].length).trim();
      if (afterImg.length > 15) first.body = afterImg;
    }
  }
  return bodies;
}

function buildQuestions(bodies) {
  return bodies.map(b => {
    const { text: noImgText, images: imgUrls } = extractImageRefs(b.body);
    const { body: cleanBody, options } = extractOptionsFromText(noImgText);

    let autoType = b.type || '单选';
    if (options.length === 0 && /解答|证明|计算|化简|求值|解方程/.test(cleanBody.substring(0, 40))) {
      autoType = '解答';
    } else if (options.length === 0 && /[_]{2,}|\\underline|___/.test(cleanBody)) {
      autoType = '填空';
    } else if (options.length > 4) {
      autoType = '多选';
    }

    return {
      number: b.number,
      type: autoType,
      content: cleanBody,
      options: options.map(cleanOptionText),
      images: imgUrls,
      answer: '',
      analysis: '',
      difficulty: '中',
      confirmed: false,
      grade: '高一',
      categoryId: '',
      categoryName: ''
    };
  });
}

function splitQuestionsFromMd(md) {
  let questionOnly = md;
  const cutHeaderRe = /(^|\n)(?:#{1,3}\s*)?(?:《[^》]*》)?(?:参[考]?考[答]?案|参考答案|【参考答案】)\s*\n?/gm;
  let cutMatch, bestCutIdx = -1;
  while ((cutMatch = cutHeaderRe.exec(md)) !== null) {
    const before = md.substring(Math.max(0, cutMatch.index - 30), cutMatch.index);
    if (/[一二三四五六七八九十]/.test(before.trim().slice(-5))) continue;
    if (cutMatch.index > bestCutIdx) bestCutIdx = cutMatch.index;
  }
  if (bestCutIdx > 0) questionOnly = md.substring(0, bestCutIdx).trim();

  let clean = cleanDoc2xContent(questionOnly);
  clean = normalizeMathDelimiters(clean);

  const sectionPatterns = [
    { re: /^#{1,3}\s*(.+?)$/gm },
    { re: /^[一二三四五六七八九十]、\s*(.+?)$/gm },
    { re: /^（[一二三四五六七八九十]）\s*(.+?)$/gm },
  ];
  const sections = [];
  for (const { re } of sectionPatterns) {
    let m;
    while ((m = re.exec(clean)) !== null) {
      sections.push({ pos: m.index, text: m[0], title: m[1] || m[0], type: detectTypeFromTitle(m[1] || m[0]) });
    }
  }
  sections.sort((a, b) => a.pos - b.pos);

  if (sections.length <= 1) {
    const allBodies = extractQuestionBodies(clean);
    if (sections.length === 1 && sections[0].type) allBodies.forEach(b => b.type = sections[0].type);
    return buildQuestions(allBodies);
  }

  const allQuestions = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const nextSec = sections[i + 1];
    const startPos = sec.pos + sec.text.length;
    const endPos = nextSec ? nextSec.pos : clean.length;
    let segmentMd = clean.substring(startPos, endPos).trim();
    segmentMd = cleanDoc2xContent(segmentMd);
    segmentMd = normalizeMathDelimiters(segmentMd);
    const bodies = extractQuestionBodies(segmentMd);
    bodies.forEach(b => b.type = sec.type || (b.number >= 13 ? '解答' : '单选'));
    const qs = buildQuestions(bodies);
    allQuestions.push(...qs);
  }
  return allQuestions;
}

// ========== Main: re-parse task ==========
const TASK_ID = 'task_1781502081405_2132fbbe';

// Load raw.md
const rawPath = path.join(__dirname, '../uploads/doc2x_images', TASK_ID, 'raw.md');
if (!fs.existsSync(rawPath)) {
  console.error('raw.md not found at', rawPath);
  process.exit(1);
}
const rawMd = fs.readFileSync(rawPath, 'utf8');

console.log('=== Re-parsing with FIXED option extraction ===');
const newQuestions = splitQuestionsFromMd(rawMd);
console.log(`Extracted ${newQuestions.length} questions\n`);

newQuestions.forEach(q => {
  const optStatus = q.options.length === 0 ? '⚠️ NO OPTS' : 
                     q.options.length >= 4 ? '✅ ' + q.options.length + ' opts' : 
                     '⚠️ only ' + q.options.length + ' opts';
  console.log(`Q${String(q.number).padStart(2)} [${q.type.padEnd(4)}] ${optStatus} | ${q.content.substring(0, 60)}...`);
  if (q.options.length > 0) {
    q.options.forEach((o, i) => console.log(`   ${String.fromCharCode(65+i)}. ${o.substring(0, 50)}`));
  }
});

// Update tasks.json
const tasksPath = path.join(__dirname, '../data/doc2x_tasks.json');
const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
const task = tasks.find(t => t.id === TASK_ID);
if (task) {
  // Preserve existing answer/analysis/difficulty/grade fields from old questions
  const oldQMap = {};
  task.questions.forEach(q => oldQMap[q.number] = q);
  
  task.questions = newQuestions.map(nq => {
    const old = oldQMap[nq.number];
    return {
      ...nq,
      // Only preserve answer/analysis if they look like real data (not mis-parsed question bodies)
      // Use old.answer only if it exists and is not empty
      answer: (old && old.answer && old.answer.trim()) ? old.answer : nq.answer,
      // NEVER carry over old analysis from student-version PDF (no answers in source)
      analysis: nq.analysis || '',
      difficulty: old ? old.difficulty : nq.difficulty,
      grade: old ? old.grade : nq.grade,
      confirmed: false  // Reset confirmed status since content changed
    };
  });
  
  fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2), 'utf8');
  console.log(`\n✅ Updated task ${TASK_ID} with ${newQuestions.length} questions`);
} else {
  console.error('\n❌ Task not found in tasks.json!');
}
