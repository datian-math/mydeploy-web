const fs = require('fs');

const data = JSON.parse(fs.readFileSync('D:/math-website/data/questions.json', 'utf8'));

let totalFixed = 0;

function cleanField(s) {
  if (typeof s !== 'string') return s;
  const orig = s;

  // 1. 删除 \end{minipage} 及之后所有内容
  s = s.replace(/\\end\{minipage\}[\s\S]*?(?=\\begin\{|\\n\\n|\\n\\item|\\n\\question|$)/g, '');
  s = s.replace(/\\end\{minipage\}[\s\S]*$/g, '');
  s = s.replace(/\\begin\{minipage\}\[?[^\]]*\]?[\s\S]*?(?=\\end\{minipage\}|$)/g, '');

  // 2. 删除末尾多余的 }
  // 计算 {} 是否平衡
  let balance = 0;
  let lastClose = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') balance++;
    else if (s[i] === '}') {
      balance--;
      lastClose = i;
    }
  }
  // 如果末尾 balance < 0，说明有多余的 }
  if (balance < 0) {
    // 从末尾开始删除多余的 }
    let b = 0;
    let result = '';
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === '}') b--;
      else if (s[i] === '{') b++;
      else if (b < 0) {
        result = s[i] + result;
      } else {
        result = s[i] + result;
      }
    }
    // 简化：直接 trim 掉末尾的 }
    s = s.replace(/\}\s*$/, (match) => {
      const before = s.slice(0, s.length - match.length);
      let ob = (before.match(/\{/g) || []).length;
      let cb = (before.match(/\}/g) || []).length;
      if (cb > ob) {
        totalFixed++;
        return '';
      }
      return match;
    });
  }

  // 3. 删除末尾孤立的反斜杠 \
  // 先看看末尾是否有不成对的 \
  s = s.replace(/\\+$/g, (match) => {
    // 如果是偶数个反斜杠，保留；奇数个则去掉最后一个
    if (match.length % 2 === 1) {
      totalFixed++;
      return match.slice(0, -1);
    }
    return match;
  });

  // 4. 删除末尾多余换行
  s = s.replace(/\n+$/g, '').trim();

  // 5. 压缩多余空行
  s = s.replace(/\n{3,}/g, '\n\n');

  if (s !== orig) totalFixed++;
  return s;
}

data.forEach(q => {
  q.content = cleanField(q.content);
  if (q.options && Array.isArray(q.options)) {
    q.options = q.options.map(o => cleanField(o));
  }
  q.analysis = cleanField(q.analysis);
});

console.log('总共修复了 ' + totalFixed + ' 处');
fs.writeFileSync('D:/math-website/data/questions.json', JSON.stringify(data, null, 2), 'utf8');
console.log('已保存');

// 验证
const data2 = JSON.parse(fs.readFileSync('D:/math-website/data/questions.json', 'utf8'));
let remain = 0;
data2.forEach(q => {
  [q.content, ...(q.options||[]), q.analysis].forEach(f => {
    if (typeof f === 'string' && /\\end\{minipage\}/.test(f)) remain++;
  });
});
console.log('残留 end{minipage} 数量:', remain);
