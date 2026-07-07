// ============================================================
// 批量修复所有任务的 analysis 错误和 type 错误
// Usage: node scripts/fix_all_tasks.cjs
// ============================================================
const fs = require('fs');
const path = require('path');

const tasksPath = path.join(__dirname, '..', 'data', 'doc2x_tasks.json');
const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));

let totalFixed = { analysis: 0, type: 0 };

for (const task of tasks) {
  const qs = task.questions || [];
  
  for (const q of qs) {
    // 1. 清空错误 analysis
    if (q.analysis && q.analysis.length > 0) {
      const cleanContent = q.content.replace(/[\s\$\n\\\（\）\【\】]+/g, '');
      const cleanAnalysis = q.analysis.replace(/[\s\$\n\\\（\）\【\】]+/g, '');
      const contentStart = cleanContent.substring(0, 25);
      const analysisStart = cleanAnalysis.substring(0, 25);
      
      // 超过100字符大概率是其他题目内容混入
      // 或者开头匹配（analysis = content 的副本）
      if (q.analysis.length > 100 || 
          (contentStart.length > 10 && contentStart === analysisStart) ||
          cleanAnalysis.length > cleanContent.length * 2) {
        q.analysis = '';
        totalFixed.analysis++;
      }
    }
    
    // 2. 修正 type
    // 多选题：内容含【多选】 OR 4选项+题号在5范围
    if ((q.content || '').includes('【多选】') && q.type !== '多选') {
      q.type = '多选';
      totalFixed.type++;
    }
    // Q5 有4选项且不是多选 → 多选（常见于 section 检测失败的情况）
    if (q.number === 5 && q.options.length >= 4 && q.type !== '多选') {
      q.type = '多选';
      totalFixed.type++;
    }
    
    // Q13-Q19 如果是"单选"→"解答"（有图片或解答类关键词）
    if (q.number >= 13 && q.number <= 25 && q.type === '单选') {
      q.type = '解答';
      totalFixed.type++;
    }
    
    // Q6-Q12 如果是"单选"→"填空"
    if (q.number >= 6 && q.number <= 12 && q.type === '单选' && q.options.length === 0) {
      q.type = '填空';
      totalFixed.type++;
    }
  }
  
  // Update questionCount
  task.questionCount = qs.length;
}

fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2), 'utf8');
console.log(`Fixed: ${totalFixed.analysis} analysis fields, ${totalFixed.type} type fields`);
