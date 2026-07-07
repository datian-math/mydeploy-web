import React from 'react';
import { ComposerQuestion, PaperSettings } from './types';

interface PreviewPanelProps {
  questions: ComposerQuestion[];
  selectedId: string | null;
  paperSettings: PaperSettings;
  questionDetails: Map<string, { title: string; type: string; difficulty: string; content: string; options: string[]; images: Record<string, string> }>;
}

/** Section 标题映射 */
const SECTION_TITLES: Record<string, string> = {
  '单选': '一、选择题（本大题共{count}小题）',
  '多选': '二、多选题（本大题共{count}小题）',
  '填空': '三、填空题（本大题共{count}小题）',
  '解答': '四、解答题（本大题共{count}小题）',
};

const TYPE_ORDER = ['单选', '多选', '填空', '解答'];

/** 按题型分组 */
function groupByType(qs: ComposerQuestion[], details: Map<string, any>) {
  const groups: { type: string; items: ComposerQuestion[] }[] = [];
  for (const t of TYPE_ORDER) {
    const items = qs.filter(q => details.get(q.questionId)?.type === t);
    if (items.length > 0) groups.push({ type: t, items });
  }
  // 其他未分类题型
  const known = new Set(TYPE_ORDER);
  const others = qs.filter(q => !known.has(details.get(q.questionId)?.type || ''));
  if (others.length > 0) groups.push({ type: '其他', items: others });
  return groups;
}

export default function PreviewPanel({ questions, selectedId, paperSettings, questionDetails }: PreviewPanelProps) {
  const groups = groupByType(questions, questionDetails);

  return (
    <div className="composer-center">
      {/* 工具栏 */}
      <div className="composer-center-toolbar">
        <span style={{ fontSize: 13, color: '#666' }}>
          预览 · {paperSettings.paperSize.toUpperCase()} · {questions.length}题
        </span>
        <span style={{ fontSize: 12, color: '#999' }}>
          {paperSettings.showPageNumber ? '📄 含页码' : ''}
        </span>
      </div>

      {/* 纸张预览 */}
      <div className="composer-center-preview">
        <div className={`paper-sheet paper-${paperSettings.paperSize}`}>
          {/* 页眉 */}
          <div className="paper-header">
            <div className="header-row">
              <span>{paperSettings.headerLeft.replace(/\[title\]/g, paperSettings.title)}</span>
              <span>{paperSettings.headerCenter}</span>
              <span>{paperSettings.headerRight.replace(/\[page\]/g, '1')}</span>
            </div>
            <div className="paper-title">{paperSettings.title}</div>
            {paperSettings.subtitle && <div className="paper-subtitle">{paperSettings.subtitle}</div>}
          </div>

          {/* 题目内容 */}
          {questions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 60, color: '#bbb' }}>
              选题篮为空，请从试题库添加题目
            </div>
          ) : (
            groups.map(group => (
              <div key={group.type}>
                <div className="paper-section-title">
                  {(SECTION_TITLES[group.type] || group.type).replace('{count}', String(group.items.length))}
                </div>
                {group.items.map((q, i) => {
                  const detail = questionDetails.get(q.questionId);
                  if (!detail) return null;
                  const isSelected = q.questionId === selectedId;
                  const s = q.style;

                  const hasImg = detail.images && Object.keys(detail.images).length > 0;
                  const imgKey = hasImg ? Object.keys(detail.images)[0] : null;
                  const imgSrc = imgKey ? (detail.images[imgKey].startsWith('http') ? detail.images[imgKey] : `/uploads/images/${detail.images[imgKey]}`) : null;

                  return (
                    <div
                      key={q.questionId}
                      className={`preview-question${isSelected ? ' selected' : ''}${s.hasBorder ? ' with-border' : ''}`}
                      style={{
                        fontFamily: s.fontFamily === '默认' ? undefined : s.fontFamily,
                        fontSize: s.fontSize,
                        color: s.fontColor,
                        fontWeight: s.bold ? 600 : 400,
                        textAlign: s.textAlign as any,
                        lineHeight: s.lineHeight,
                        borderColor: s.hasBorder ? s.borderColor : undefined,
                        borderStyle: s.hasBorder ? s.borderStyle : undefined,
                        borderRadius: s.hasBorder ? s.borderRadius : undefined,
                      }}
                    >
                      <strong>{i + 1}.</strong>{' '}
                      <span dangerouslySetInnerHTML={{ __html: detail.content || detail.title || '' }} />

                      {/* 图片 */}
                      {imgSrc && (
                        <div className="preview-image" style={{ textAlign: s.imageAlign }}>
                          <img src={imgSrc} alt="题目图片" style={{ width: s.imageWidth, maxWidth: '100%' }} />
                        </div>
                      )}

                      {/* 选项 */}
                      {detail.options && detail.options.length > 0 && (
                        <div className={`preview-options layout-${s.optionLayout}`}>
                          {detail.options.map((opt: string, oi: number) => (
                            <span key={oi} className="option-item" dangerouslySetInnerHTML={{ __html: `${String.fromCharCode(65 + oi)}. ${opt}` }} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}

          {/* 页脚 */}
          {paperSettings.showPageNumber && (
            <div className="paper-footer">— 1 —</div>
          )}
        </div>
      </div>
    </div>
  );
}
