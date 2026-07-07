/**
 * PdfBatchEntry.tsx — PDF 批量录题组件（增强版 v2）
 *
 * 增强特性：
 *   - MathJax 实时公式渲染（审核时可视化公式效果）
 *   - 内容编辑能力（修正 Doc2X 解析偏差）
 *   - 批量操作（全选题型/难度修改）
 *   - 图片内联显示
 *   - 键盘快捷键导航
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';

// ========== 类型定义 ==========
interface BatchTask {
  id: string;
  filename: string;
  status: 'processing' | 'ready' | 'confirmed' | 'failed';
  createdAt: string;
  questionCount: number;
  totalPages: number;
  error?: string;
  allImages?: string[]; // PDF 中提取的全部配图 URL 列表
}

interface BatchQuestion {
  number: number;
  type: string;
  content: string;
  options: string[];
  images: string[];
  figureTexts: string[];
  answer: string;
  analysis: string;
  difficulty: string;
  grade?: string;
  categoryId?: string;
  categoryName?: string;
  confirmed: boolean;
}

interface FullTask extends BatchTask {
  defaults: { grade: string; difficulty: string; categoryId: string; categoryName: string };
  questions: BatchQuestion[];
  pageMd?: string[];   // 逐页 markdown（页面截图对照用）
}

interface PageInfo {
  page: number;
  questionNumbers: number[];
}

interface Category {
  id: string;
  name: string;
  children?: Category[];
}

// ========== API ==========
const API = 'http://localhost:3001';

async function apiRequest(path: string, options?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  return res.json();
}

// ========== 左侧预览文本清理 ==========
function _previewText(text?: string): string {
  if (!text) return '(空)';
  let cleaned = text
    // 替换图片标签
    .replace(/<img[^>]+>/gi, '[图]')
    // 替换 display math $$ ... $$
    .replace(/\$\$[\s\S]*?\$\$/g, '[公式]')
    // 替换 display math \[ ... \]
    .replace(/\\\[[\s\S]*?\\\]/g, '[公式]')
    // 替换 inline math \( ... \) — 非贪婪，但需要处理嵌套花括号
    .replace(/\\\((?:[^\\]|\\(?!\)))*?\\\)/g, '[公式]')
    // 替换 inline math $...$（不含 $$）
    .replace(/\$(?!\$)(?:[^\$\\]|\\.)*?\$/g, '[公式]')
    // 兜底：替换裸 LaTeX 命令序列（以反斜杠字母开头，含花括号参数）
    .replace(/\\(?:frac|sqrt|sin|cos|tan|cot|sec|csc|log|ln|lg|lim|sup|inf|sum|prod|int|oint|iint|iiint|left|right|big[lrg]?|text|mathrm|mathbf|mathbb|mathcal|mathscr|mathtt|begin\{.*?\}|end\{.*?\}|quad|qquad|cdot|times|div|pm|mp|leq|geq|neq|equiv|sim|cong|approx|subset|supset|subseteq|supseteq|cup|cap|in|notin|ni|forall|exists|nabla|partial|grad|vec|hat|bar|overline|underline|tilde|dot|ddot|breve|widehat|widetilde|overbrace|underbrace|alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|infty|partial|nabla|forall|exists|emptyset|in|notin|subset|supset|cap|cup|vee|wedge|oplus|otimes|odot|oslash|ldots|cdots|vdots|ddots|[a-zA-Z]+\{(?:[^{}]|{[^}]*})*\})+(?:\s*[a-zA-Z\u4e00-\u9fff\(【])/g, '[公式]')
    // 清理残留的孤立 LaTeX 分隔符和标记
    .replace(/【详解】/g, ' ')
    // 清理多余空白
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ');
  return cleaned.substring(0, 80) + (cleaned.length > 80 ? '...' : '');
}

// ========== 轻量 MathJax 渲染 ==========
function MathJaxRender({ text, style }: { text: string; style?: React.CSSProperties }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let timer: number;
    const check = () => {
      if ((window as any).MathJax?.typesetPromise) {
        setReady(true);
      } else {
        timer = window.setTimeout(check, 300);
      }
    };
    check();
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!containerRef.current || !ready || !text) return;
    try {
      // 处理图片引用
      let html = text
        .replace(/<img\s+src="([^"]+)"\/?>/g, (_, src) => {
          const fullUrl = src.startsWith('http') ? src : `${API}${src}`;
          return `<img src="${fullUrl}" style="max-width:200px;max-height:150px;margin:8px 0;border-radius:6px;border:1px solid #e0e0e0;" />`;
        })
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br/>');

      if (!html.startsWith('<p>')) html = `<p>${html}</p>`;
      containerRef.current.innerHTML = html;
      (window as any).MathJax.typesetPromise([containerRef.current]).catch(() => {});
    } catch (e) {
      if (containerRef.current) {
        containerRef.current.innerHTML = `<p style="color:#c33">[渲染错误]</p>`;
      }
    }
  }, [text, ready]);

  if (!ready) {
    return <div style={{ ...style, color: '#999', fontSize: 13 }}>加载公式引擎...</div>;
  }

  return (
    <div
      ref={containerRef}
      style={{
        fontSize: 14,
        lineHeight: 1.8,
        color: '#333',
        wordBreak: 'break-word',
        ...style
      }}
    />
  );
}

// ========== 子视图：上传页 ==========
function UploadView({
  onUploaded,
  categories
}: {
  onUploaded: (taskId: string) => void;
  categories: Category[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [grade, setGrade] = useState('高一');
  const [difficulty, setDifficulty] = useState('中');
  const [engine, setEngine] = useState('mineru-local');
  const [selectedCatId, setSelectedCatId] = useState('');
  const [selectedCatName, setSelectedCatName] = useState('');
  const [error, setError] = useState('');

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.name.toLowerCase().endsWith('.pdf')) {
      setFile(f);
      setError('');
    } else if (f) {
      setError('请上传 PDF 文件');
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setError('');
    }
  }, []);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1];
        const res = await apiRequest('/api/pdf-batch/upload', {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            fileData: base64,
            grade,
            difficulty,
            engine,
            categoryId: selectedCatId,
            categoryName: selectedCatName
          })
        });
        if (res.taskId) {
          setTimeout(() => onUploaded(res.taskId), 1500);
        } else {
          setError('上传失败：' + (res.error || '未知错误'));
          setUploading(false);
        }
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      setError('上传失败：' + err.message);
      setUploading(false);
    }
  };

  const getCategoryPath = (catId: string) => {
    for (const cat of categories) {
      if (cat.children) {
        for (const sub of cat.children) {
          if (sub.id === catId) return { parent: cat.name, child: sub.name };
        }
      }
      if (cat.id === catId) return { parent: cat.name, child: '' };
    }
    return { parent: '', child: '' };
  };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '24px 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 6, color: '#1a1a2e' }}>
          📤 PDF 试卷批量录题
        </h2>
        <p style={{ color: '#666', fontSize: 14 }}>
          上传含公式和图形的数学试卷 PDF，由 AI 引擎自动识别公式和图片，一键入库
        </p>
      </div>

      {/* 拖拽区 */}
      <div
        onDrop={handleDrop}
        onDragOver={e => e.preventDefault()}
        style={{
          border: '2px dashed ' + (file ? '#4CAF50' : '#d0d0d0'),
          borderRadius: 16,
          padding: '48px 20px',
          textAlign: 'center',
          background: file ? 'linear-gradient(135deg, #f0fdf0, #e8f5e9)' : 'linear-gradient(135deg, #fafafa, #f5f5f5)',
          cursor: 'pointer',
          transition: 'all 0.3s',
          marginBottom: 24,
          boxShadow: file ? '0 0 20px rgba(76,175,80,0.15)' : 'none'
        }}
        onClick={() => document.getElementById('pdf-file-input')?.click()}
      >
        <input
          id="pdf-file-input"
          type="file"
          accept=".pdf"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        {file ? (
          <div>
            <div style={{ fontSize: 40, marginBottom: 8 }}>📄</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#2e7d32' }}>{file.name}</div>
            <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>
              {(file.size / 1024).toFixed(0)} KB — 点击或拖拽更换文件
            </div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📁</div>
            <div style={{ fontSize: 16, color: '#555' }}>
              拖拽 PDF 到此处，或 <span style={{ color: '#1976d2', fontWeight: 600 }}>点击选择文件</span>
            </div>
            <div style={{ fontSize: 13, color: '#999', marginTop: 8 }}>
              支持含数学公式和图形的试卷 PDF
            </div>
          </div>
        )}
      </div>

      {/* 默认属性 */}
      <div style={{
        background: '#fff',
        border: '1px solid #e8e8e8',
        borderRadius: 12,
        padding: 24,
        marginBottom: 20,
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
      }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16, color: '#333' }}>
          📋 默认题目属性 <span style={{ fontSize: 12, color: '#999', fontWeight: 400 }}>（审核时可逐题修改）</span>
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={labelStyle}>年级</label>
            <select value={grade} onChange={e => setGrade(e.target.value)} style={selectStyle}>
              <option value="高一">高一</option>
              <option value="高二">高二</option>
              <option value="高三">高三</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>难度</label>
            <select value={difficulty} onChange={e => setDifficulty(e.target.value)} style={selectStyle}>
              <option value="较易">较易</option>
              <option value="易">易</option>
              <option value="中">中</option>
              <option value="较难">较难</option>
              <option value="难">难</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>解析引擎</label>
            <select
              value={engine}
              onChange={e => setEngine(e.target.value)}
              style={selectStyle}
            >
              <option value="mineru-local">MinerU 本地解析（推荐，免费）</option>
              <option value="qwen-vlm">Qwen 多模态 LaTeX 识别（精准，慢）</option>
              <option value="mineru-api">MinerU v4 云端解析（需Token）</option>
              <option value="doc2x">Doc2X</option>
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>知识点分类（可选）</label>
            <select
              value={selectedCatId}
              onChange={e => {
                setSelectedCatId(e.target.value);
                const cp = getCategoryPath(e.target.value);
                setSelectedCatName(cp.child || cp.parent);
              }}
              style={selectStyle}
            >
              <option value="">— 不指定 —</option>
              {categories.map(cat => (
                cat.children && cat.children.length > 0 ? (
                  <optgroup key={cat.id} label={cat.name}>
                    {cat.children.map(sub => (
                      <option key={sub.id} value={sub.id}>{cat.name} — {sub.name}</option>
                    ))}
                  </optgroup>
                ) : (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                )
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* 按钮 */}
      <button onClick={handleUpload} disabled={!file || uploading} style={uploadBtnStyle(file, uploading)}>
        {uploading ? '⏳ 正在上传并提交 AI 解析...' : '🚀 开始解析录入'}
      </button>

      {error && (
        <div style={{ marginTop: 12, padding: '10px 16px', background: '#ffebee', borderRadius: 8, color: '#c62828', fontSize: 14 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 24, padding: '16px 20px', background: '#f5f5f5', borderRadius: 10, fontSize: 13, color: '#777', lineHeight: 1.6 }}>
        <strong>💡 工作流程：</strong> 上传 PDF → AI 解析公式+排版 → 切题+提取选项 → 审核确认 → 入库到试题库<br/>
        <strong>⚡ 解析引擎：</strong> MinerU 本地解析 (magic-pdf，免费) / Qwen 多模态 (精准慢) / MinerU v4 (云端 VLM) / Doc2X (备选) <br/>
        <strong>⏱ 解析耗时：</strong> 通常 15-30 秒，取决于 PDF 页数和复杂度<br/>
        <strong>🔑 适用场景：</strong> 有明确题号分隔的标准化试卷效果最佳
      </div>
    </div>
  );
}

// 上传按钮样式
function uploadBtnStyle(file: File | null, uploading: boolean): React.CSSProperties {
  const active = file && !uploading;
  return {
    width: '100%',
    padding: '16px 24px',
    fontSize: 16,
    fontWeight: 600,
    color: '#fff',
    background: active
      ? 'linear-gradient(135deg, #1976d2, #1565c0)'
      : '#ccc',
    border: 'none',
    borderRadius: 10,
    cursor: active ? 'pointer' : 'not-allowed',
    transition: 'all 0.2s',
    boxShadow: active ? '0 4px 12px rgba(25,118,210,0.3)' : 'none'
  };
}

// ========== 子视图：任务列表 ==========
function ListView({
  onOpenReview,
  onRefresh,
  onDelete
}: {
  onOpenReview: (taskId: string) => void;
  onRefresh: number;
  onDelete?: () => void;
}) {
  const [tasks, setTasks] = useState<BatchTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      const data = await apiRequest('/api/pdf-batch/list');
      if (!cancelled) {
        setTasks(Array.isArray(data) ? data : []);
        setLoading(false);
      }
    };
    fetch();
    const timer = setInterval(fetch, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [onRefresh]);

  const handleDelete = async (taskId: string) => {
    if (!confirm('确定删除此任务及其图片？')) return;
    await apiRequest(`/api/pdf-batch/${taskId}`, { method: 'DELETE' });
    setTasks(prev => prev.filter(t => t.id !== taskId));
    onDelete?.();
  };

  if (loading) {
    return <div style={{ padding: 60, textAlign: 'center', color: '#999' }}>加载中...</div>;
  }

  if (tasks.length === 0) {
    return (
      <div style={{ padding: 80, textAlign: 'center' }}>
        <div style={{ fontSize: 56, marginBottom: 16, opacity: 0.5 }}>📭</div>
        <div style={{ fontSize: 18, color: '#999', fontWeight: 500 }}>暂无录题任务</div>
        <div style={{ fontSize: 14, color: '#bbb', marginTop: 8 }}>上传一份 PDF 试卷即可开始</div>
      </div>
    );
  }

  const statusBadge = (status: string) => {
    const cfg: Record<string, { bg: string; text: string; color: string }> = {
      processing: { bg: '#fff3e0', text: '🔍 解析中', color: '#e65100' },
      ready: { bg: '#e8f5e9', text: '✅ 待审核', color: '#2e7d32' },
      confirmed: { bg: '#e3f2fd', text: '📥 已入库', color: '#1565c0' },
      failed: { bg: '#ffebee', text: '❌ 失败', color: '#c62828' }
    };
    const c = cfg[status] || cfg.processing;
    return <span style={{ ...badgeStyle, background: c.bg, color: c.color }}>{c.text}</span>;
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 0' }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20, color: '#1a1a2e' }}>
        📋 PDF 录题任务列表
      </h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e0e0e0', textAlign: 'left' }}>
              <th style={thStyle}>文件名</th>
              <th style={{ ...thStyle, width: 60 }}>页数</th>
              <th style={{ ...thStyle, width: 60 }}>题目</th>
              <th style={{ ...thStyle, width: 110 }}>状态</th>
              <th style={{ ...thStyle, width: 100 }}>时间</th>
              <th style={{ ...thStyle, width: 140 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map(t => (
              <tr key={t.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={tdStyle}>
                  <span style={{ fontWeight: 500 }}>📄 {t.filename}</span>
                  {t.error && <div style={{ fontSize: 12, color: '#c62828', marginTop: 4 }}>{t.error}</div>}
                </td>
                <td style={tdStyle}>{t.totalPages || '-'}</td>
                <td style={tdStyle}>{t.questionCount || '-'}</td>
                <td style={tdStyle}>{statusBadge(t.status)}</td>
                <td style={{ ...tdStyle, fontSize: 13, color: '#888' }}>
                  {new Date(t.createdAt).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                  })}
                </td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(t.status === 'ready' || t.status === 'confirmed') && (
                      <button onClick={() => onOpenReview(t.id)} style={actionBtnStyle('primary')}>
                        {t.status === 'ready' ? '审核' : '查看'}
                      </button>
                    )}
                    <button onClick={() => handleDelete(t.id)} style={actionBtnStyle('danger')}>
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ========== 子视图：审核编辑（增强版）==========
function ReviewView({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [task, setTask] = useState<FullTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  // PDF 页面截图对照
  const [pageDataUrls, setPageDataUrls] = useState<{ url: string; w: number; h: number }[]>([]);
  const [questionPageMap, setQuestionPageMap] = useState<Map<number, number>>(new Map());
  const [showPageStrip, setShowPageStrip] = useState(true);
  const [fullPageModal, setFullPageModal] = useState<{ url: string; pageNum: number } | null>(null);
  const pdfRenderedRef = useRef(false);
  const stripRef = useRef<HTMLDivElement>(null);

  // 渲染 PDF 页面 → dataURL
  const renderPdfPages = useCallback(async (totalPages: number) => {
    try {
      const pdfjsLib = (window as any).pdfjsLib;
      if (!pdfjsLib?.getDocument) {
        console.warn('pdf.js not loaded yet');
        return;
      }
      const pdfUrl = `${API}/api/pdf-batch/${taskId}/pdf`;
      const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
      const scale = Math.max(0.5, Math.min(1.2, 600 / 595));
      const pages: { url: string; w: number; h: number }[] = [];
      for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport }).promise;
        pages.push({ url: canvas.toDataURL('image/jpeg', 0.75), w: viewport.width, h: viewport.height });
      }
      setPageDataUrls(pages);
    } catch (e) {
      console.error('PDF render error:', e);
    }
  }, [taskId]);

  useEffect(() => {
    apiRequest(`/api/pdf-batch/${taskId}`).then(data => {
      setTask(data);
      setLoading(false);
      // 加载页面信息并渲染 PDF
      if (!pdfRenderedRef.current) {
        pdfRenderedRef.current = true;
        apiRequest(`/api/pdf-batch/${taskId}/page-info`).then((pi: any) => {
          const m = new Map<number, number>();
          if (pi?.pages) {
            pi.pages.forEach((p: PageInfo) => {
              p.questionNumbers.forEach(n => m.set(n, p.page));
            });
            setQuestionPageMap(m);
            if (pi.totalPages > 0) {
              renderPdfPages(pi.totalPages);
            }
          }
        }).catch(() => {});
      }
    });
  }, [taskId, renderPdfPages]);

  // 当前题目在第几页
  const q = task?.questions?.[selectedIdx] || null;
  const currentQPage = q ? (questionPageMap.get(q.number) || 1) : 1;

  // 选中题目切换时，横向滚动页面条到对应页
  useEffect(() => {
    if (stripRef.current && showPageStrip && pageDataUrls.length > 0) {
      const target = stripRef.current.querySelector(`[data-page="${currentQPage}"]`) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
  }, [currentQPage, showPageStrip, pageDataUrls.length]);

  // 自动保存到后端
  const updateQuestion = useCallback(async (idx: number, field: string, value: any) => {
    if (!task) return;
    const newQuestions = [...task.questions];
    (newQuestions[idx] as any)[field] = value;
    setTask({ ...task, questions: newQuestions });

    try {
      await apiRequest(`/api/pdf-batch/${taskId}/question`, {
        method: 'PUT',
        body: JSON.stringify({ questionIndex: idx, updates: { [field]: value } })
      });
    } catch (e) {
      console.error('Save failed:', e);
    }
  }, [task, taskId]);

  const toggleConfirm = (idx: number) => {
    if (!task) return;
    const newQuestions = [...task.questions];
    newQuestions[idx].confirmed = !newQuestions[idx].confirmed;
    setTask({ ...task, questions: newQuestions });
    apiRequest(`/api/pdf-batch/${taskId}/question`, {
      method: 'PUT',
      body: JSON.stringify({ questionIndex: idx, updates: { confirmed: newQuestions[idx].confirmed } })
    }).catch(console.error);
  };

  // 批量操作
  const batchSetType = (newType: string) => {
    if (!task) return;
    task.questions.forEach((_, i) => {
      if (task.questions[i].confirmed || confirm(`将所有题目题型改为「${newType}」？`)) {
        updateQuestion(i, 'type', newType);
      }
    });
  };

  const batchSetDifficulty = (newDiff: string) => {
    if (!task) return;
    task.questions.forEach((_, i) => updateQuestion(i, 'difficulty', newDiff));
  };

  const selectAll = () => {
    if (!task) return;
    task.questions.forEach((_, i) => updateQuestion(i, 'confirmed', true));
  };

  const deselectAll = () => {
    if (!task) return;
    task.questions.forEach((_, i) => updateQuestion(i, 'confirmed', false));
  };

  const handleConfirmAll = async () => {
    if (!task) return;
    const confirmedIds = task.questions
      .map((q, i) => q.confirmed ? i : -1)
      .filter(i => i >= 0);

    if (confirmedIds.length === 0) {
      alert('请先勾选要入库的题目（点击题号旁的 ✓）');
      return;
    }

    if (!confirm(`确定将 ${confirmedIds.length} 道题入库？`)) return;

    setSaving(true);
    try {
      const res = await apiRequest(`/api/pdf-batch/${taskId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ questionIds: confirmedIds })
      });
      if (res.success) {
        setSavedMsg(`🎉 成功入库 ${res.savedCount} 道题目！`);
        // 后端已移除已入库的题目并返回更新后的任务数据
        if (res.updatedTask) {
          setTask(res.updatedTask);
          setSelectedIdx(0);
        } else {
          // 兼容：如果没有返回更新数据，标记已确认的题目
          const updatedQuestions = task.questions.map((q: any, i) =>
            confirmedIds.includes(i) ? { ...q, _imported: true } : q
          ).filter((q: any) => !q._imported);
          setTask({ ...task, questions: updatedQuestions, questionCount: updatedQuestions.length, status: updatedQuestions.length === 0 ? 'confirmed' : task.status });
          setSelectedIdx(0);
        }
      } else {
        alert('入库失败：' + (res.error || '未知错误'));
      }
    } catch (err: any) {
      alert('入库失败：' + err.message);
    }
    setSaving(false);
  };

  // 键盘快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (!task) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setSelectedIdx(prev => Math.max(0, prev - 1));
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        setSelectedIdx(prev => Math.min(task.questions.length - 1, prev + 1));
      }
      if (e.key === ' ' && !e.ctrlKey) {
        e.preventDefault();
        toggleConfirm(selectedIdx);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [task, selectedIdx]);

  if (loading) return <div style={{ padding: 60, textAlign: 'center', color: '#999' }}>加载中...</div>;
  if (!task || task.status === 'processing') {
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div>
        <div style={{ fontSize: 16, color: '#666' }}>正在解析中，页面会自动刷新</div>
        <button onClick={onBack} style={{ marginTop: 20, padding: '8px 20px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}>
          返回列表
        </button>
      </div>
    );
  }

  const confirmedCount = task.questions.filter(q => q.confirmed).length;
  const questionCounts = task.questions.reduce((acc: Record<string, number>, q) => {
    acc[q.type] = (acc[q.type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 100px)' }}>
      {/* 顶栏 */}
      <div style={topBarStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} style={backBtnStyle}>← 返回列表</button>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: '#333' }}>{task.filename}</h2>
          <span style={{ fontSize: 12, color: '#888' }}>{task.totalPages} 页 · {task.questionCount} 题</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: '#666' }}>
            已确认 {confirmedCount}/{task.questionCount}
          </span>
          <button
            onClick={handleConfirmAll}
            disabled={saving || task.status === 'confirmed' || confirmedCount === 0}
            style={confirmBtnStyle(saving, task.status)}
            title={confirmedCount > 0 ? `将 ${confirmedCount} 道已确认题目入库` : '请先勾选要入库的题目'}
          >
            {saving ? '入库中...' : task.status === 'confirmed' ? '✅ 全部已入库' : `📥 入库 (${confirmedCount})`}
          </button>
        </div>
      </div>

      {savedMsg && (
        <div style={successBannerStyle}>{savedMsg}</div>
      )}

      {/* 批量操作栏 */}
      <div style={batchBarStyle}>
        <span style={{ fontSize: 12, color: '#888', fontWeight: 500 }}>批量操作：</span>
        <button onClick={selectAll} style={batchBtnStyle}>全选</button>
        <button onClick={deselectAll} style={batchBtnStyle}>全不选</button>
        <span style={{ width: 1, height: 20, background: '#e0e0e0', margin: '0 4px' }} />
        <span style={{ fontSize: 12, color: '#888' }}>题型：</span>
        {['单选', '多选', '填空', '解答'].map(t => (
          <button key={t} onClick={() => batchSetType(t)} style={batchBtnStyle}>{t}</button>
        ))}
        <span style={{ width: 1, height: 20, background: '#e0e0e0', margin: '0 4px' }} />
        <span style={{ fontSize: 12, color: '#888' }}>难度：</span>
        {['较易', '易', '中', '较难', '难'].map(d => (
          <button key={d} onClick={() => batchSetDifficulty(d)} style={batchBtnStyle}>{d}</button>
        ))}
        <span style={{ width: 1, height: 20, background: '#e0e0e0', margin: '0 4px' }} />
        <button
          onClick={async () => {
            setSaving(true);
            try {
              const res = await apiRequest(`/api/pdf-batch/${taskId}/llm-reparse`, { method: 'POST' });
              if (res.success) {
                setSavedMsg(`LLM 解析完成，共 ${res.questionCount} 题`);
                // 刷新任务数据
                const updated = await apiRequest(`/api/pdf-batch/${taskId}`);
                setTask(updated);
              } else {
                setSavedMsg('LLM 解析失败');
              }
            } catch(e) {
              setSavedMsg('LLM 解析出错');
            }
            setSaving(false);
            setTimeout(() => setSavedMsg(''), 3000);
          }}
          disabled={saving}
          style={{
            ...batchBtnStyle,
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: '#fff', border: 'none', fontWeight: 600, letterSpacing: 0.5,
          }}
        >🤖 LLM智能解析</button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#aaa' }}>提示：在题目区按 Space 确认，方向键切换</span>
      </div>

      {/* PDF 页面截图对照条 */}
      {pageDataUrls.length > 0 && (
        <div style={{
          borderBottom: '1px solid #d0d7de', borderTop: '1px solid #d0d7de',
          background: '#f5f6f8',
        }}>
          {/* 标题栏 */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 12px', background: '#e8ecf1',
            borderBottom: '1px solid #d0d7de',
          }}>
            <button
              onClick={() => setShowPageStrip(!showPageStrip)}
              style={{
                border: '1px solid #c0c8d0', borderRadius: 4, cursor: 'pointer',
                padding: '2px 10px', fontSize: 12, background: '#fff',
                flexShrink: 0, fontWeight: 500,
              }}
            >
              {showPageStrip ? '− 收起页面' : '+ 展开页面'}
            </button>
            <span style={{ fontSize: 11, color: '#888' }}>
              {pageDataUrls.length} 页 · 当前题在第 {currentQPage} 页 · 点击缩略图查看大图
            </span>
          </div>
          {/* 缩略图滚动区 */}
          {showPageStrip && (
            <div ref={stripRef} style={{
              display: 'flex', gap: 10, padding: '10px 14px',
              overflowX: 'auto', overflowY: 'hidden',
              height: 210, alignItems: 'flex-start',
            }}>
              {pageDataUrls.map((page, i) => {
                const pageNum = i + 1;
                const isActive = currentQPage === pageNum;
                const pageQs = questionPageMap.size > 0
                  ? Array.from(questionPageMap.entries()).filter(([, p]) => p === pageNum).map(([n]) => n)
                  : [];
                const thumbH = 190;
                const thumbW = Math.round(thumbH * page.w / page.h);
                return (
                  <div
                    key={i}
                    data-page={pageNum}
                    onClick={() => setFullPageModal({ url: page.url, pageNum })}
                    style={{
                      flexShrink: 0, cursor: 'pointer', position: 'relative',
                      border: isActive ? '3px solid #1a73e8' : '2px solid #d0d7de',
                      borderRadius: 6, overflow: 'hidden',
                      background: '#fff',
                      boxShadow: isActive ? '0 2px 12px rgba(26,115,232,0.35)' : '0 1px 4px rgba(0,0,0,0.08)',
                      transition: 'border-color 0.2s, box-shadow 0.2s',
                    }}
                    title={`第 ${pageNum} 页 — 点击查看大图`}
                  >
                    <img
                      src={page.url}
                      alt={`第${pageNum}页`}
                      style={{ display: 'block', width: thumbW, height: thumbH, objectFit: 'cover', objectPosition: 'top' }}
                    />
                    <div style={{
                      position: 'absolute', top: 4, left: 6,
                      fontSize: 11, fontWeight: 700, color: isActive ? '#fff' : '#333',
                      background: isActive ? '#1a73e8' : 'rgba(255,255,255,0.9)',
                      borderRadius: 4, padding: '2px 8px',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                    }}>
                      第{pageNum}页
                    </div>
                    {pageQs.length > 0 && (
                      <div style={{
                        position: 'absolute', bottom: 4, right: 4,
                        fontSize: 10, color: '#333', background: 'rgba(255,255,255,0.9)',
                        borderRadius: 4, padding: '1px 6px',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                      }}>
                        题{pageQs.join(',')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 大图模态框 */}
      {fullPageModal && (
        <div
          onClick={() => setFullPageModal(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 10, overflow: 'hidden',
              boxShadow: '0 12px 48px rgba(0,0,0,0.35)',
              maxWidth: '92vw', maxHeight: '92vh',
              display: 'flex', flexDirection: 'column',
            }}
          >
            {/* 模态框标题栏 */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 18px', background: '#f0f4f8', borderBottom: '1px solid #ddd',
            }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                📄 第 {fullPageModal.pageNum} 页 / 共 {pageDataUrls.length} 页
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => {
                    const prev = fullPageModal.pageNum - 2;
                    if (prev >= 0) setFullPageModal({ url: pageDataUrls[prev].url, pageNum: prev + 1 });
                  }}
                  disabled={fullPageModal.pageNum <= 1}
                  style={modalNavBtnStyle(fullPageModal.pageNum <= 1)}
                >← 上一页</button>
                <button
                  onClick={() => {
                    const next = fullPageModal.pageNum;
                    if (next < pageDataUrls.length) setFullPageModal({ url: pageDataUrls[next].url, pageNum: next + 1 });
                  }}
                  disabled={fullPageModal.pageNum >= pageDataUrls.length}
                  style={modalNavBtnStyle(fullPageModal.pageNum >= pageDataUrls.length)}
                >下一页 →</button>
                <button onClick={() => setFullPageModal(null)}
                  style={{ border: '1px solid #ccc', borderRadius: 5, padding: '4px 14px', fontSize: 13, cursor: 'pointer', background: '#fff' }}
                >✕ 关闭</button>
              </div>
            </div>
            {/* 大图 */}
            <div style={{ overflow: 'auto', padding: 20, display: 'flex', justifyContent: 'center', background: '#eee' }}>
              <img
                src={fullPageModal.url}
                alt={`第${fullPageModal.pageNum}页`}
                style={{ maxWidth: '100%', height: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,0.2)', borderRadius: 4 }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 主内容：左题列表 + 中编辑区 + 右图片画廊 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 左题列表 */}
        <div style={leftPanelStyle}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #eee', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Object.entries(questionCounts).map(([type, count]) => (
              <span key={type} style={typeTagStyle}>{type} × {count}</span>
            ))}
          </div>
          {task.questions.map((q, idx) => (
            <div
              key={idx}
              onClick={() => setSelectedIdx(idx)}
              style={questionItemStyle(selectedIdx === idx, q.confirmed)}
            >
              <span onClick={e => { e.stopPropagation(); toggleConfirm(idx); }} style={checkCircleStyle(q.confirmed)}>
                {q.confirmed ? '✓' : ''}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* 第一行：编号 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#333', flexShrink: 0 }}>{q.number}.</span>
                  <span style={{ ...typeChipStyle, fontSize: 10 }}>{q.type}</span>
                  {q.images?.length > 0 && <span style={{ fontSize: 10 }}>🖼</span>}
                </div>
                {/* 第二行：题目内容预览 */}
                <div style={{ ...questionPreviewStyle, marginBottom: q.answer ? 4 : 0 }}>
                  {_previewText(q.content)}
                </div>
                {/* 第三行：答案（如果有） */}
                {q.answer && (
                  <div style={{ fontSize: 11, color: '#4caf50', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>▸ 答案:</span>
                    <span>{_previewText(q.answer).replace(/\.{3}$/, '')}</span>
                    {q.analysis && <span style={{ color: '#999', fontWeight: 400, fontSize: 10 }}>[有解析]</span>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 右图片画廊 */}
        {(task.allImages && task.allImages.length > 0) && (
          <ImageGalleryPanel
            images={task.allImages}
            currentQuestion={q as any}
            onAssignImage={(imgUrl) => {
              if (!q) return;
              // 将图片添加到当前选中题目（去重）
              const updated = [...(q.images || [])];
              if (!updated.includes(imgUrl)) {
                updated.push(imgUrl);
              }
              updateQuestion(selectedIdx, 'images', updated);
            }}
            onRemoveImage={(imgUrl) => {
              if (!q || !q.images) return;
              updateQuestion(selectedIdx, 'images', q.images.filter(u => u !== imgUrl));
            }}
          />
        )}

        {/* 中编辑区 */}
        {q ? (
          <div style={{ flex: 1, overflowY: 'auto', padding: 24, background: '#fafcfe' }}>
            <QuestionEditor
              question={q}
              index={selectedIdx}
              total={task.questions.length}
              onUpdate={(field, val) => updateQuestion(selectedIdx, field, val)}
              onPrev={() => setSelectedIdx(prev => Math.max(0, prev - 1))}
              onNext={() => setSelectedIdx(prev => Math.min(task.questions.length - 1, prev + 1))}
            />
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
            请从左侧选择一道题目
          </div>
        )}
      </div>
    </div>
  );
}

// ========== 单题编辑器（增强版 — 含 MathJax 渲染 + 内容编辑）==========
function QuestionEditor({
  question: q,
  index,
  total,
  onUpdate,
  onPrev,
  onNext
}: {
  question: BatchQuestion;
  index: number;
  total: number;
  onUpdate: (field: string, value: any) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [editingContent, setEditingContent] = useState(false);
  const [tempContent, setTempContent] = useState(q.content || '');
  const [editingAnalysis, setEditingAnalysis] = useState(false);
  const [tempAnalysis, setTempAnalysis] = useState(q.analysis || '');
  const [showLatexSource, setShowLatexSource] = useState(false);
  // 选项编辑状态（组件内部）
  const [editingOptionIdx, setEditingOptionIdx] = useState<number | null>(null);
  const [editOptDraft, setEditOptDraft] = useState('');

  useEffect(() => {
    setTempContent(q.content || '');
    setEditingContent(false);
  }, [q.content, index]);

  useEffect(() => {
    setTempAnalysis(q.analysis || '');
    setEditingAnalysis(false);
  }, [q.analysis, index]);

  const types = ['单选', '多选', '填空', '解答'];
  const difficulties = ['较易', '易', '中', '较难', '难'];
  const grades = ['高一', '高二', '高三'];

  return (
    <div style={{ maxWidth: 760 }}>
      {/* 导航 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onPrev} disabled={index === 0} style={navBtnStyle(index === 0)}>← 上一题</button>
          <button onClick={onNext} disabled={index >= total - 1} style={navBtnStyle(index >= total - 1)}>下一题 →</button>
        </div>
        <span style={{ fontSize: 14, color: '#666', fontWeight: 500 }}>
          {index + 1} / {total}
        </span>
      </div>

      {/* 属性标签行 */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <FieldChip label="题型" value={q.type} options={types} onChange={v => onUpdate('type', v)} />
        <FieldChip label="难度" value={q.difficulty} options={difficulties} onChange={v => onUpdate('difficulty', v)} />
        <FieldChip label="年级" value={q.grade || '高一'} options={grades} onChange={v => onUpdate('grade', v)} />
        {q.answer && (
          <span style={{ padding: '3px 10px', borderRadius: 6, fontSize: 13, background: '#e8f5e9', color: '#2e7d32', fontWeight: 600 }}>
            答案：{q.answer}
          </span>
        )}
      </div>

      {/* 题干（带 MathJax 实时预览 + LaTeX 源码切换） */}
      <div style={editSectionStyle}>
        <div style={sectionHeaderStyle}>
          <span style={{ fontWeight: 600, color: '#444' }}>📝 题干内容</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => setShowLatexSource(!showLatexSource)}
              style={{
                ...editToggleStyle,
                background: showLatexSource ? '#534AB7' : '#f0f0f0',
                color: showLatexSource ? '#fff' : '#666',
                border: '1px solid #ddd',
                fontSize: 12,
                padding: '2px 10px'
              }}
            >
              {showLatexSource ? '📐 渲染预览' : '📋 LaTeX 源码'}
            </button>
            <button
              onClick={() => {
                if (editingContent) { onUpdate('content', tempContent); }
                setEditingContent(!editingContent);
              }}
              style={editToggleStyle}
            >
              {editingContent ? '💾 保存' : '✏️ 编辑'}
            </button>
          </div>
        </div>
        {editingContent ? (
          <textarea
            value={tempContent}
            onChange={e => setTempContent(e.target.value)}
            style={contentTextareaStyle}
            rows={6}
            placeholder="题干内容（支持 LaTeX 公式）"
          />
        ) : showLatexSource ? (
          <pre style={{
            padding: 12,
            background: '#f5f5f5',
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.6,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            border: '1px solid #e0e0e0',
            color: '#555',
            fontFamily: 'Menlo, Monaco, Consolas, monospace',
            maxHeight: 320,
            overflowY: 'auto'
          }}>
            {q.content || '(空)'}
          </pre>
        ) : (
          <MathJaxRender text={q.content} style={{ padding: '8px 0' }} />
        )}
      </div>

      {/* 选项 */}
      {q.type === '单选' || q.type === '多选' ? (
        <div style={editSectionStyle}>
          <div style={sectionHeaderStyle}>
            <span style={{ fontWeight: 600, color: '#444' }}>📋 选项</span>
            <span style={{ fontSize: 12, color: '#999' }}>（{q.options?.length || 0} 个）</span>
            <button
              onClick={() => onUpdate('options', [...(q.options || []), '']) }
              style={{
                marginLeft: 'auto', padding: '2px 10px', fontSize: 12,
                border: '1px solid #4caf50', borderRadius: 4, cursor: 'pointer',
                background: '#fff', color: '#2e7d32', fontWeight: 500,
              }}
              title="添加选项"
            >+ 添加</button>
          </div>
          {q.options && q.options.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {q.options.map((opt, i) => {
                const isEditing = editingOptionIdx === i;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <span style={{
                      fontWeight: 700, color: '#1976d2', flexShrink: 0,
                      marginTop: isEditing ? 8 : 2, fontSize: 13, minWidth: 20,
                    }}>
                      {String.fromCharCode(65 + i)}.
                    </span>
                    {isEditing ? (
                      <>
                        <textarea
                          value={editOptDraft}
                          onChange={e => setEditOptDraft(e.target.value)}
                          style={{
                            flex: 1, minHeight: 40, fontSize: 14, fontFamily: 'inherit',
                            border: '1px solid #1976d2', borderRadius: 6, padding: '6px 10px',
                            background: '#fff', resize: 'vertical',
                          }}
                          rows={2}
                          placeholder="选项内容（支持 LaTeX）"
                        />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                          <button
                            onClick={() => {
                              const newOpts = [...q.options];
                              newOpts[i] = editOptDraft;
                              onUpdate('options', newOpts);
                              setEditingOptionIdx(null);
                              setEditOptDraft('');
                            }}
                            style={optBtnStyle('save')}
                            title="保存"
                          >✓</button>
                          <button
                            onClick={() => { setEditingOptionIdx(null); setEditOptDraft(''); }}
                            style={optBtnStyle('cancel')}
                            title="取消"
                          >✕</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ flex: 1, ...optionCardStyle }}>
                          <MathJaxRender text={opt} style={{ fontSize: 14 }} />
                        </div>
                        <button
                          onClick={() => { setEditingOptionIdx(i); setEditOptDraft(opt); }}
                          style={optBtnStyle('edit')}
                          title="编辑此选项"
                        >✏️</button>
                        <button
                          onClick={() => {
                            const newOpts = q.options.filter((_, j) => j !== i);
                            onUpdate('options', newOpts);
                          }}
                          style={optBtnStyle('delete')}
                          title="删除此选项"
                        >🗑️</button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 12, color: '#999', textAlign: 'center', background: '#f9f9f9', borderRadius: 6 }}>
              未提取到选项 — 点击「+ 添加」手动补充
            </div>
          )}
        </div>
      ) : null}

      {/* 图片 */}
      {q.images && q.images.length > 0 && (
        <div style={editSectionStyle}>
          <div style={sectionHeaderStyle}>
            <span style={{ fontWeight: 600, color: '#444' }}>🖼️ 题目配图</span>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {q.images.map((url, i) => (
              <img
                key={i}
                src={url.startsWith('http') ? url : `${API}${url}`}
                alt={`题目${q.number}图${i + 1}`}
                style={{
                  maxWidth: 220,
                  maxHeight: 180,
                  borderRadius: 8,
                  border: '1px solid #e0e0e0',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                  objectFit: 'contain',
                  background: '#fff'
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* 答案（选择/填空） */}
      {(q.type === '单选' || q.type === '多选' || q.type === '填空') && (
        <div style={editSectionStyle}>
          <div style={sectionHeaderStyle}>
            <span style={{ fontWeight: 600, color: '#444' }}>✅ 正确答案</span>
          </div>
          <input
            type="text"
            value={q.answer}
            onChange={e => onUpdate('answer', e.target.value)}
            placeholder={q.type === '填空' ? '答案格式：\\sqrt{2}' : '答案格式：A / AB'}
            style={inputFieldStyle}
          />
          {/* 答案渲染预览（含 LaTeX 时显示） */}
          {q.answer && /\\[\(\[]/.test(q.answer) && (
            <div style={{ marginTop: 6, padding: '8px 12px', background: '#f8f9fa', borderRadius: 6, border: '1px solid #e8eaed' }}>
              <span style={{ fontSize: 11, color: '#999', marginRight: 6 }}>预览：</span>
              <MathJaxRender text={q.answer} style={{ fontSize: 14, color: '#1a73e8', display: 'inline' }} />
            </div>
          )}
        </div>
      )}

      {/* 解析 */}
      <div style={editSectionStyle}>
        <div style={sectionHeaderStyle}>
          <span style={{ fontWeight: 600, color: '#444' }}>📖 解析</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {!editingAnalysis && q.analysis && (
              <button
                onClick={() => setShowLatexSource(!showLatexSource)}
                style={{
                  ...editToggleStyle,
                  background: showLatexSource ? '#534AB7' : '#f0f0f0',
                  color: showLatexSource ? '#fff' : '#666',
                  border: '1px solid #ddd',
                  fontSize: 12,
                  padding: '2px 10px'
                }}
              >
                {showLatexSource ? '📐 渲染预览' : '📋 LaTeX 源码'}
              </button>
            )}
            <button
              onClick={() => {
                if (editingAnalysis) { onUpdate('analysis', tempAnalysis); }
                setEditingAnalysis(!editingAnalysis);
              }}
              style={editToggleStyle}
            >
              {editingAnalysis ? '💾 保存' : '✏️ 编辑'}
            </button>
          </div>
        </div>
        {editingAnalysis ? (
          <textarea
            value={tempAnalysis}
            onChange={e => setTempAnalysis(e.target.value)}
            style={contentTextareaStyle}
            rows={5}
            placeholder="解析内容（支持 LaTeX 公式）"
          />
        ) : q.analysis ? (
          showLatexSource ? (
            <pre style={{
              padding: 12,
              background: '#f5f5f5',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.6,
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              border: '1px solid #e0e0e0',
              color: '#555',
              fontFamily: 'Menlo, Monaco, Consolas, monospace',
              maxHeight: 256,
              overflowY: 'auto'
            }}>
              {q.analysis || '(空)'}
            </pre>
          ) : (
            <MathJaxRender text={q.analysis} style={{ padding: '8px 0', fontSize: 14, color: '#555' }} />
          )
        ) : (
          <div style={{ padding: 12, color: '#999', textAlign: 'center', background: '#f9f9f9', borderRadius: 6 }}>
            暂无解析
          </div>
        )}
      </div>

      <div style={{ fontSize: 12, color: '#bbb', marginTop: 20, textAlign: 'center', padding: '12px 0' }}>
        ⌨ 快捷键：← → 切换题目 · Space 确认/取消 · 编辑后点击 💾 保存
      </div>
    </div>
  );
}

/**
 * 图片画廊面板（参考奇思妙想LATEX设计）
 * 显示 PDF 提取的全部配图缩略图，支持：
 * - 点击放大预览
 * - 拖拽/点击分配给当前选中题目
 * - 查看当前题目已关联的图片
 */
function ImageGalleryPanel({ images, currentQuestion, onAssignImage, onRemoveImage }: {
  images: string[];
  currentQuestion: BatchQuestion | undefined;
  onAssignImage: (imgUrl: string) => void;
  onRemoveImage: (imgUrl: string) => void;
}) {
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // 当前题目的图片集合
  const assignedImages = currentQuestion?.images || [];
  const unassignedImages = images.filter(img => !assignedImages.includes(img));

  return (
    <div style={{
      width: 270, borderLeft: '1px solid #e8e8e8', overflowY: 'auto',
      background: '#fafbfc', flexShrink: 0, display: 'flex', flexDirection: 'column'
    }}>
      {/* 标题栏 */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #eee', background: '#fff' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#333', display: 'flex', alignItems: 'center', gap: 6 }}>
          🖼️ 全部配图
          <span style={{ fontSize: 11, color: '#999', fontWeight: 400 }}>({images.length} 张)</span>
        </div>
        {currentQuestion && (
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            当前题 Q{currentQuestion.number} 已分配 {assignedImages.length}/{images.length}
          </div>
        )}
      </div>

      {/* 当前题已分配的图片 */}
      {assignedImages.length > 0 && (
        <div style={{ borderBottom: '1px solid #eee' }}>
          <div style={{ padding: '6px 14px', fontSize: 11, color: '#2e7d32', fontWeight: 600, background: '#f1f8e9' }}>
            ✓ 本题已选 ({assignedImages.length})
          </div>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {assignedImages.map((url, i) => {
              const fname = url.split('/').pop() || `图${i + 1}`;
              return (
                <div key={i}
                  onMouseEnter={() => setHoverIdx(i)}
                  onMouseLeave={() => setHoverIdx(null)}
                  style={{
                    position: 'relative', borderRadius: 8, overflow: 'hidden',
                    border: '2px solid #4caf50', background: '#fff', boxShadow: '0 2px 6px rgba(0,0,0,0.08)'
                  }}
                >
                  <img
                    src={url.startsWith('http') ? url : `${API}${url}`}
                    alt={fname}
                    style={{ width: '100%', height: 100, objectFit: 'contain', display: 'block' }}
                  />
                  <div style={{ padding: '4px 8px', fontSize: 11, color: '#555', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {fname}
                  </div>
                  {/* 删除按钮 */}
                  <button
                    onClick={(e) => { e.stopPropagation(); onRemoveImage(url); }}
                    title="从本题移除"
                    style={{
                      position: 'absolute', top: 4, right: 4, width: 22, height: 22,
                      borderRadius: '50%', background: 'rgba(220,53,69,0.9)', color: '#fff',
                      border: 'none', cursor: 'pointer', fontSize: 12, lineHeight: '22px',
                      textAlign: 'center', opacity: hoverIdx === i ? 1 : 0.5,
                      transition: 'opacity 0.15s'
                    }}
                  >✕</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 未分配/全部图片列表 */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '6px 14px', fontSize: 11, color: '#888', fontWeight: 600, background: '#f5f5f5', position: 'sticky', top: 0 }}>
          {unassignedImages.length > 0 ? `待分配 (${unassignedImages.length})` : '全部图片'}
        </div>
        <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(unassignedImages.length > 0 ? unassignedImages : images).map((url, i) => {
            const fname = url.split('/').pop() || `图${i + 1}`;
            const isAssigned = assignedImages.includes(url);
            return (
              <div
                key={i}
                onClick={() => !isAssigned && currentQuestion && onAssignImage(url)}
                onDoubleClick={() => setPreviewImg(url)}
                onMouseEnter={() => setHoverIdx(images.indexOf(url))}
                onMouseLeave={() => setHoverIdx(null)}
                style={{
                  cursor: isAssigned ? 'default' : (currentQuestion ? 'pointer' : 'not-allowed'),
                  borderRadius: 8, overflow: 'hidden',
                  border: isAssigned ? '2px solid #4caf50' : '1px solid #e0e0e0',
                  background: '#fff',
                  transition: 'all 0.15s',
                  boxShadow: hoverIdx === images.indexOf(url) ? '0 3px 12px rgba(25,118,210,0.15)' : '0 1px 3px rgba(0,0,0,0.06)',
                  transform: hoverIdx === images.indexOf(url) ? 'translateY(-1px)' : 'none'
                }}
              >
                <img
                  src={url.startsWith('http') ? url : `${API}${url}`}
                  alt={fname}
                  style={{ width: '100%', height: 90, objectFit: 'contain', display: 'block', background: '#fafafa' }}
                />
                <div style={{
                  padding: '4px 8px', fontSize: 10.5, color: '#666',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  fontFamily: 'Menlo, Consolas, monospace'
                }}>
                  {fname}
                </div>
                {!isAssigned && currentQuestion && (
                  <div style={{
                    padding: '2px 8px', fontSize: 10, color: '#1976d2', textAlign: 'center',
                    background: '#e3f2fd', borderTop: '1px solid #e0e0e0'
                  }}>
                    点此分配给 Q{currentQuestion.number}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 图片放大预览 Modal */}
      {previewImg && (
        <div
          onClick={() => setPreviewImg(null)}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out'
          }}
        >
          <img
            src={previewImg.startsWith('http') ? previewImg : `${API}${previewImg}`}
            alt="预览"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.4)' }}
          />
          <div style={{ position: 'absolute', bottom: 24, color: '#fff', fontSize: 13, textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>
            双击缩略图打开 · 点击背景关闭 · {(previewImg.split('/').pop() || '')}
          </div>
        </div>
      )}
    </div>
  );
}

// ========== 微型组件 ==========
function FieldChip({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 12, color: '#999', fontWeight: 500 }}>{label}:</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{
          padding: '4px 10px', fontSize: 13, border: '1px solid #ddd',
          borderRadius: 6, background: '#fff', cursor: 'pointer', outline: 'none'
        }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

// ========== 样式常量 ==========
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 500, color: '#555', marginBottom: 4 };
const selectStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #ddd', borderRadius: 8, background: '#fff' };
const thStyle: React.CSSProperties = { padding: '12px 14px', fontSize: 13, fontWeight: 600, color: '#555' };
const tdStyle: React.CSSProperties = { padding: '12px 14px', fontSize: 14, color: '#333' };
const badgeStyle: React.CSSProperties = { display: 'inline-block', padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600 };
const navBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '6px 16px', fontSize: 13, border: '1px solid #ddd', borderRadius: 6,
  background: '#fff', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.3 : 1
});
const editSectionStyle: React.CSSProperties = {
  marginBottom: 16, padding: 18, background: '#fff', border: '1px solid #e8e8e8', borderRadius: 10,
  boxShadow: '0 1px 2px rgba(0,0,0,0.04)'
};
const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #f0f0f0'
};
const editToggleStyle: React.CSSProperties = {
  padding: '3px 12px', fontSize: 12, border: '1px solid #ddd', borderRadius: 4,
  background: '#fff', cursor: 'pointer', color: '#666'
};
const contentTextareaStyle: React.CSSProperties = {
  width: '100%', padding: '12px', fontSize: 14, fontFamily: "'Segoe UI', 'Noto Sans SC', monospace",
  border: '1px solid #ddd', borderRadius: 8, boxSizing: 'border-box', lineHeight: 1.7,
  resize: 'vertical', minHeight: 120
};
const inputFieldStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', fontSize: 14, border: '1px solid #ddd',
  borderRadius: 8, boxSizing: 'border-box', fontFamily: "monospace"
};
const optionCardStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', padding: '10px 14px',
  background: '#fafcfe', border: '1px solid #eee', borderRadius: 8, gap: 8
};
const actionBtnStyle = (variant: string): React.CSSProperties => ({
  padding: '5px 14px', fontSize: 13, fontWeight: 500, border: 'none', borderRadius: 6, cursor: 'pointer',
  background: variant === 'primary' ? '#1976d2' : '#ff5252',
  color: '#fff'
});
const topBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '12px 20px', background: '#fff', borderBottom: '1px solid #e8e8e8',
  boxShadow: '0 1px 4px rgba(0,0,0,0.04)'
};
const backBtnStyle: React.CSSProperties = {
  padding: '6px 14px', fontSize: 13, border: '1px solid #ddd', borderRadius: 6,
  background: '#fff', cursor: 'pointer'
};
const confirmBtnStyle = (saving: boolean, status: string): React.CSSProperties => {
  const disabled = saving || status === 'confirmed';
  return {
    padding: '8px 24px', fontSize: 14, fontWeight: 600, color: '#fff',
    background: disabled ? '#ccc' : 'linear-gradient(135deg, #4caf50, #2e7d32)',
    border: 'none', borderRadius: 8, cursor: disabled ? 'default' : 'pointer',
    boxShadow: disabled ? 'none' : '0 2px 8px rgba(76,175,80,0.3)'
  };
};
const successBannerStyle: React.CSSProperties = {
  padding: '12px 24px', background: 'linear-gradient(135deg, #e8f5e9, #c8e6c9)',
  color: '#2e7d32', fontSize: 15, fontWeight: 600, textAlign: 'center'
};
const batchBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', background: '#f8f8f8', borderBottom: '1px solid #eee',
  flexWrap: 'wrap', fontSize: 13
};
const batchBtnStyle: React.CSSProperties = {
  padding: '3px 10px', fontSize: 12, border: '1px solid #ddd', borderRadius: 4,
  background: '#fff', cursor: 'pointer', color: '#555'
};
const leftPanelStyle: React.CSSProperties = {
  width: 320, borderRight: '1px solid #e8e8e8', overflowY: 'auto',
  background: '#fafafa', flexShrink: 0
};
const modalNavBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '4px 14px', fontSize: 13, cursor: disabled ? 'default' : 'pointer',
  border: '1px solid #ccc', borderRadius: 5, background: disabled ? '#eee' : '#fff',
  color: disabled ? '#bbb' : '#333',
});
const optBtnStyle = (kind: 'edit' | 'delete' | 'save' | 'cancel'): React.CSSProperties => ({
  padding: '3px 8px', fontSize: 13, cursor: 'pointer', flexShrink: 0,
  border: '1px solid ' + (kind === 'save' ? '#4caf50' : kind === 'cancel' ? '#ff5252' : '#ddd'),
  borderRadius: 5, background: '#fff',
  color: kind === 'save' ? '#2e7d32' : kind === 'cancel' ? '#d32f2f' : '#666',
});
const questionItemStyle = (selected: boolean, confirmed: boolean): React.CSSProperties => ({
  padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #f0f0f0',
  background: selected ? '#e3f2fd' : confirmed ? '#f1f8e9' : 'transparent',
  borderLeft: selected ? '3px solid #1976d2' : confirmed ? '3px solid #4caf50' : '3px solid transparent',
  transition: 'all 0.15s', display: 'flex', alignItems: 'flex-start', gap: 10
});
const checkCircleStyle = (confirmed: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22, borderRadius: 11, flexShrink: 0, marginTop: 1,
  border: confirmed ? 'none' : '2px solid #ccc', background: confirmed ? '#4caf50' : '#fff',
  color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer'
});
const typeTagStyle: React.CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 8, background: '#e3f2fd', color: '#1565c0'
};
const typeChipStyle: React.CSSProperties = {
  fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#f0f0f0', color: '#666'
};
const questionPreviewStyle: React.CSSProperties = {
  fontSize: 12, color: '#888', marginTop: 4, overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 250
};

// ========== 主组件 ==========
type ViewMode = 'upload' | 'list' | 'review';

interface PdfBatchEntryProps {
  categories: Category[];
}

export default function PdfBatchEntry({ categories }: PdfBatchEntryProps) {
  const [view, setView] = useState<ViewMode>('upload');
  const [reviewTaskId, setReviewTaskId] = useState<string>('');
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleUploaded = (taskId: string) => {
    setRefreshTrigger(Date.now());
    setTimeout(() => setView('list'), 2000);
  };

  const handleOpenReview = (taskId: string) => {
    setReviewTaskId(taskId);
    setView('review');
  };

  return (
    <div style={{ height: '100%' }}>
      {/* 顶部导航 */}
      <div style={{
        display: 'flex', gap: 0, borderBottom: '2px solid #e8e8e8',
        padding: '0 24px', background: '#fff'
      }}>
        {[
          { key: 'upload', label: '📤 上传 PDF', icon: '📤' },
          { key: 'list', label: '📋 任务列表', icon: '📋' },
        ].map(tab => (
          <div
            key={tab.key}
            onClick={() => {
              if (view === 'review' && tab.key !== 'review') {
                if (!confirm('正在审核中，确定离开？修改已自动保存。')) return;
              }
              setView(tab.key as ViewMode);
            }}
            style={{
              padding: '14px 24px',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 500,
              color: view === tab.key ? '#1976d2' : '#666',
              borderBottom: view === tab.key ? '3px solid #1976d2' : '3px solid transparent',
              marginBottom: -2,
              transition: 'all 0.2s',
              background: view === tab.key ? '#f5f9ff' : 'transparent'
            }}
          >
            {tab.label}
          </div>
        ))}
      </div>

      {/* 视图内容 */}
      <div style={{ padding: '0 24px', overflow: 'auto', height: 'calc(100% - 50px)' }}>
        {view === 'upload' && <UploadView onUploaded={handleUploaded} categories={categories} />}
        {view === 'list' && <ListView onOpenReview={handleOpenReview} onRefresh={refreshTrigger} />}
        {view === 'review' && <ReviewView taskId={reviewTaskId} onBack={() => setView('list')} />}
      </div>
    </div>
  );
}
