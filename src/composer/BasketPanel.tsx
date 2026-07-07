import React, { useRef, useState } from 'react';

interface ComposerItem {
  questionId: string;
  order: number; // 原始 basketIds 中的索引
  style: any;
  rawQuestion: any;
}

interface Props {
  items: ComposerItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 题型内排序：fromIdx 和 toIdx 均为原始 basketIds 中的索引 */
  onReorder: (fromIdx: number, toIdx: number) => void;
  onRemove: (id: string) => void;
}

const TYPE_ORDER = ['单选', '多选', '填空', '解答'];
const TYPE_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  '单选': { label: '单选题', color: '#1976d2', bg: '#e3f2fd', border: '#bbdefb' },
  '多选': { label: '多选题', color: '#f57c00', bg: '#fff3e0', border: '#ffe0b2' },
  '填空': { label: '填空题', color: '#2e7d32', bg: '#e8f5e9', border: '#c8e6c9' },
  '解答': { label: '解答题', color: '#c62828', bg: '#fce4ec', border: '#f8bbd0' },
};

export default function BasketPanel({ items, selectedId, onSelect, onReorder, onRemove }: Props) {
  // 正在拖动的原始索引（用 ref 避免闭包问题）
  const dragFromIdx = useRef<number>(-1);
  const dragType = useRef<string>('');
  const [dragOverIdx, setDragOverIdx] = useState<number>(-1);

  // 按题型分组（保持原始顺序）
  const groups: { type: string; items: ComposerItem[] }[] = [];
  for (const t of TYPE_ORDER) {
    const matched = items.filter(q => q.rawQuestion.type === t);
    if (matched.length > 0) groups.push({ type: t, items: matched });
  }
  const known = new Set(TYPE_ORDER);
  const others = items.filter(q => !known.has(q.rawQuestion.type || ''));
  if (others.length > 0) groups.push({ type: '其他', items: others });

  if (items.length === 0) {
    return (
      <div className="basket-empty">
        <p>选题篮为空</p>
        <p style={{ fontSize: 12, color: '#999' }}>从试题库添加题目到这里</p>
      </div>
    );
  }

  const handleDragStart = (e: React.DragEvent, order: number, type: string) => {
    dragFromIdx.current = order;
    dragType.current = type;
    e.dataTransfer.effectAllowed = 'move';
    // ⚠️ 必须设置 data，否则某些浏览器不触发拖拽
    e.dataTransfer.setData('text/plain', String(order));
    (e.currentTarget as HTMLElement).style.opacity = '0.5';
    console.log('[drag] start', order, type);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    setDragOverIdx(-1);
    console.log('[drag] end');
  };

  const handleDragOver = (e: React.DragEvent, order: number, type: string) => {
    if (type !== dragType.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIdx !== order) {
      setDragOverIdx(order);
      console.log('[drag] over', order);
    }
  };

  const handleDragLeave = () => {
    setDragOverIdx(-1);
  };

  const handleDrop = (e: React.DragEvent, toOrder: number, type: string) => {
    e.preventDefault();
    setDragOverIdx(-1);
    const fromIdx = dragFromIdx.current;
    console.log('[drag] drop from:', fromIdx, 'to:', toOrder, 'type:', type, 'dragType:', dragType.current);
    if (fromIdx === -1 || fromIdx === toOrder) {
      console.log('[drag] ignored: same position or no drag source');
      return;
    }
    if (type !== dragType.current) {
      console.log('[drag] ignored: cross-type drop');
      return;
    }
    onReorder(fromIdx, toOrder);
  };

  return (
    <div className="basket-groups">
      {groups.map(group => {
        const meta = TYPE_META[group.type] || {
          label: group.type, color: '#666', bg: '#f5f5f5', border: '#ddd',
        };
        return (
          <div key={group.type} className="basket-group">
            <div
              className="basket-group-header"
              style={{ background: meta.bg, borderColor: meta.border }}
            >
              <span style={{ color: meta.color, fontWeight: 600, fontSize: 13 }}>
                {meta.label}
              </span>
              <span style={{ fontSize: 11, color: '#999' }}>
                {group.items.length} 题
              </span>
            </div>
            <div className="basket-group-body">
              {group.items.map((item, localIdx) => {
                const q = item.rawQuestion;
                const isSelected = item.questionId === selectedId;
                // ⚠️ 关键修复：使用 item.order（原始 basketIds 索引），而不是 filter 后的数组索引
                const originalIdx = item.order;
                const isDragOver = dragOverIdx === originalIdx;

                return (
                  <div
                    key={item.questionId}
                    className={`basket-item${isSelected ? ' selected' : ''}${isDragOver ? ' drag-over' : ''}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, originalIdx, group.type)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleDragOver(e, originalIdx, group.type)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, originalIdx, group.type)}
                    onClick={() => onSelect(item.questionId)}
                    style={{ cursor: 'grab' }}
                  >
                    {/* 拖动手柄图标 */}
                    <span
                      className="drag-handle"
                      title="拖动排序（限本题型内）"
                    >⠿</span>
                    <span className="item-index">{localIdx + 1}</span>
                    <span
                      className="item-content-preview"
                      title={q.title || q.content || ''}
                    >
                      {q.title || q.content?.slice(0, 28) || '(无内容)'}
                    </span>
                    <div className="item-actions">
                      <span
                        className="item-remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(item.questionId);
                        }}
                        title="移除"
                      >×</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
