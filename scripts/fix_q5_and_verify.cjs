// Fix Q5 options and verify all 19 questions data quality
const fs = require('fs');
const path = require('path');

const tasksPath = path.join(__dirname, '../data/doc2x_tasks.json');
const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
const task = tasks[0];

console.log('=== Task:', task.id, '===');

// ---- Fix Q5 ----
const q5 = task.questions.find(q => q.number === 5);
console.log('\nQ5 before fix:');
console.log('  type:', q5.type);
q5.options.forEach((o, i) => console.log('  opt[' + i + ']:', o.substring(0, 100)));

// The A option contains "mathrm{B}.f..." which is B option embedded in LaTeX
// Split pattern: find "$ \mathrm{B}." or "\) \mathrm{B}." inside A option
const aOpt = q5.options[0];
const mathrmbIdx = aOpt.indexOf('mathrm{B}');

if (mathrmbIdx > 0) {
  // Find the start of the embedded B marker: look backwards from mathrmbIdx for '$' or '\('
  // The A content ends before the LaTeX expression containing mathrm{B}
  // Find the last '$ ' or '$' that starts the LaTeX around mathrm{B}
  let aEndIdx = mathrmbIdx;
  // Walk back to find the opening $ of the LaTeX env containing mathrm{B}
  // Pattern: "... \) $ \mathrm{B}." - look for $ before mathrm
  const beforeMathrm = aOpt.substring(0, mathrmbIdx);
  const lastDollar = beforeMathrm.lastIndexOf('$');
  if (lastDollar >= 0) {
    aEndIdx = lastDollar;
  }
  
  const aContent = aOpt.substring(0, aEndIdx).trim()
    .replace(/\s*\$\s*$/, '')  // remove trailing $ if any
    .trim();

  // B content: everything after "mathrm{B}." 
  const afterBDot = aOpt.indexOf('.', mathrmbIdx + 'mathrm{B}'.length);
  const bContent = aOpt.substring(afterBDot + 1).trim()
    .replace(/^\)?\s*/, '')  // remove leading ) if any
    .trim();

  console.log('\n  A content:', aContent.substring(0, 80));
  console.log('  B content:', bContent.substring(0, 80));

  q5.type = '多选';
  q5.options = [
    aContent,
    bContent,
    q5.options[1],  // was C (index 1)
    q5.options[2]   // was D (index 2)
  ];
  
  console.log('\nQ5 after fix:');
  q5.options.forEach((o, i) => console.log('  opt[' + i + ']:', o.substring(0, 80)));
} else {
  console.log('  mathrm{B} not found - setting type to 多选 and keeping 3 opts');
  q5.type = '多选';
}

// ---- Verify all questions ----
console.log('\n=== Full quality report ===');
let hasIssues = false;
task.questions.forEach(q => {
  const issues = [];
  if (q.analysis && q.analysis.length > 100) issues.push('analysis_too_long:' + q.analysis.length);
  if ((q.type === '单选' || q.type === '多选') && q.options.length < 4) issues.push('opts:' + q.options.length + '/4');
  if ((q.type === '单选' || q.type === '多选') && q.options.length > 4) issues.push('opts_excess:' + q.options.length);
  // Q13-Q19 should be 解答 not 单选
  if (q.number >= 13 && q.type === '单选') issues.push('wrong_type:should_be_解答');
  
  const statusEmoji = issues.length === 0 ? '✅' : '⚠️';
  console.log(statusEmoji + ' Q' + String(q.number).padStart(2) + ' [' + q.type.padEnd(2) + '] opts=' + q.options.length + (issues.length ? ' ISSUES: ' + issues.join(', ') : ''));
  if (issues.length) hasIssues = true;
});

fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2), 'utf8');
console.log('\n' + (hasIssues ? '⚠️ Some issues remain (see above)' : '✅ All questions look good!'));
console.log('Saved to', tasksPath);
