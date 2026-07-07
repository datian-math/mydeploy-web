import React from 'react';
import { ComposerQuestion, QuestionStyle, DEFAULT_STYLE, PaperSettings, DEFAULT_PAPER } from './types';

interface PropertyPanelProps {
  selectedQuestion: ComposerQuestion | null;
  paperSettings: PaperSettings;
  onStyleChange: (questionId: string, style: Partial<QuestionStyle>) => void;
  onPaperSettingsChange: (settings: Partial<PaperSettings>) => void;
  onExport: (type: 'student' | 'teacher' | 'student-latex' | 'teacher-latex') => void;
  onClear: () => void;
}

/** Toggle 开关 */
function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`toggle ${value ? 'on' : 'off'}`}
      onClick={() => onChange(!value)}
    />
  );
}

export default function PropertyPanel({
  selectedQuestion, paperSettings, onStyleChange, onPaperSettingsChange, onExport, onClear,
}: PropertyPanelProps) {
  if (!selectedQuestion) {
    return (
      <div className="composer-right">
        <div className="composer-right-header">属性配置</div>
        <div className="property-empty">
          <div style={{ fontSize: 36, marginBottom: 8 }}>👈</div>
          <div>请先选择一道题目</div>
          <div style={{ fontSize: 12, color: '#bbb', marginTop: 4 }}>点击左侧选题篮中的题目</div>
        </div>
        <div className="composer-right-footer">
          <button className="btn-export btn-export-primary" onClick={() => onExport('student')}>📄 导出学生版 PDF</button>
          <button className="btn-export btn-export-secondary" onClick={() => onExport('teacher')}>📄 导出教师版 PDF</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-export btn-export-secondary" style={{ flex: 1 }} onClick={() => onExport('student-latex')}>📦 学生版 LaTeX</button>
            <button className="btn-export btn-export-secondary" style={{ flex: 1 }} onClick={() => onExport('teacher-latex')}>📦 教师版 LaTeX</button>
          </div>
          <button style={{ width: '100%', padding: 8, borderRadius: 6, border: '0.5px solid #fcc', background: '#fee', color: '#c33', fontSize: 12, cursor: 'pointer' }} onClick={onClear}>🗑 清空选题篮</button>
        </div>
      </div>
    );
  }

  const s = selectedQuestion.style;
  const update = (partial: Partial<QuestionStyle>) => onStyleChange(selectedQuestion.questionId, partial);

  return (
    <div className="composer-right">
      <div className="composer-right-header">属性配置 · #{selectedQuestion.order}</div>
      <div className="composer-right-body">
        {/* 字体 */}
        <div className="property-group">
          <div className="property-group-title">字体</div>
          <div className="property-row">
            <label>字体</label>
            <select value={s.fontFamily} onChange={e => update({ fontFamily: e.target.value as any })}>
              <option value="默认">默认</option>
              <option value="宋体">宋体</option>
              <option value="楷体">楷体</option>
              <option value="黑体">黑体</option>
            </select>
          </div>
          <div className="property-row">
            <label>字号</label>
            <input type="number" min={10} max={24} value={s.fontSize} onChange={e => update({ fontSize: Number(e.target.value) })} />
          </div>
          <div className="property-row">
            <label>颜色</label>
            <input type="color" value={s.fontColor} onChange={e => update({ fontColor: e.target.value })} />
          </div>
          <div className="property-row">
            <label>加粗</label>
            <Toggle value={s.bold} onChange={v => update({ bold: v })} />
          </div>
        </div>

        {/* 段落 */}
        <div className="property-group">
          <div className="property-group-title">段落</div>
          <div className="property-row">
            <label>对齐</label>
            <select value={s.textAlign} onChange={e => update({ textAlign: e.target.value as any })}>
              <option value="left">左对齐</option>
              <option value="center">居中</option>
              <option value="right">右对齐</option>
              <option value="justify">两端对齐</option>
            </select>
          </div>
          <div className="property-row">
            <label>行距</label>
            <input type="number" min={1} max={3} step={0.1} value={s.lineHeight} onChange={e => update({ lineHeight: Number(e.target.value) })} />
          </div>
        </div>

        {/* 框线 */}
        <div className="property-group">
          <div className="property-group-title">框线</div>
          <div className="property-row">
            <label>显示框线</label>
            <Toggle value={s.hasBorder} onChange={v => update({ hasBorder: v })} />
          </div>
          {s.hasBorder && (
            <>
              <div className="property-row">
                <label>框线颜色</label>
                <input type="color" value={s.borderColor} onChange={e => update({ borderColor: e.target.value })} />
              </div>
              <div className="property-row">
                <label>框线样式</label>
                <select value={s.borderStyle} onChange={e => update({ borderStyle: e.target.value as any })}>
                  <option value="solid">实线</option>
                  <option value="dashed">虚线</option>
                </select>
              </div>
              <div className="property-row">
                <label>圆角</label>
                <input type="number" min={0} max={20} value={s.borderRadius} onChange={e => update({ borderRadius: Number(e.target.value) })} />
              </div>
            </>
          )}
        </div>

        {/* 选项排列 */}
        <div className="property-group">
          <div className="property-group-title">选项排列</div>
          <div className="property-row">
            <label>排列方式</label>
            <select value={s.optionLayout} onChange={e => update({ optionLayout: e.target.value as any })}>
              <option value="horizontal-4">一行四个</option>
              <option value="horizontal-2">一行两个</option>
              <option value="vertical">竖排</option>
            </select>
          </div>
        </div>

        {/* 图片 */}
        <div className="property-group">
          <div className="property-group-title">图片</div>
          <div className="property-row">
            <label>宽度</label>
            <select value={s.imageWidth} onChange={e => update({ imageWidth: e.target.value })}>
              <option value="25%">25%</option>
              <option value="35%">35%</option>
              <option value="50%">50%</option>
              <option value="75%">75%</option>
              <option value="100%">100%</option>
              <option value="150px">150px</option>
              <option value="200px">200px</option>
              <option value="300px">300px</option>
            </select>
          </div>
          <div className="property-row">
            <label>对齐</label>
            <select value={s.imageAlign} onChange={e => update({ imageAlign: e.target.value as any })}>
              <option value="left">左对齐</option>
              <option value="center">居中</option>
              <option value="right">右对齐</option>
            </select>
          </div>
        </div>

        {/* 重置样式 */}
        <button
          style={{
            width: '100%', padding: 8, borderRadius: 6,
            border: '0.5px solid #ddd', background: '#f5f5f5',
            color: '#888', fontSize: 12, cursor: 'pointer', marginTop: 8,
          }}
          onClick={() => update(DEFAULT_STYLE)}
        >
          重置为默认样式
        </button>
      </div>

      {/* 导出按钮 */}
      <div className="composer-right-footer">
        <button className="btn-export btn-export-primary" onClick={() => onExport('student')}>📄 导出学生版 PDF</button>
        <button className="btn-export btn-export-secondary" onClick={() => onExport('teacher')}>📄 导出教师版 PDF</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-export btn-export-secondary" style={{ flex: 1 }} onClick={() => onExport('student-latex')}>📦 学生版 LaTeX</button>
          <button className="btn-export btn-export-secondary" style={{ flex: 1 }} onClick={() => onExport('teacher-latex')}>📦 教师版 LaTeX</button>
        </div>
        <button style={{ width: '100%', padding: 8, borderRadius: 6, border: '0.5px solid #fcc', background: '#fee', color: '#c33', fontSize: 12, cursor: 'pointer' }} onClick={onClear}>🗑 清空选题篮</button>
      </div>
    </div>
  );
}
