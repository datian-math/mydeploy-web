// 云端白板列表：打开 / 删除 / 另存为新的
import React, { useCallback, useEffect, useState } from 'react'
import * as cloud from './cloud'

interface Props {
  onOpen: (id: string) => void
  onClose: () => void
}

export default function CloudBoardDialog({ onOpen, onClose }: Props) {
  const [rows, setRows] = useState<cloud.CloudBoardSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRows(await cloud.listBoards())
    } catch (err) {
      setError(cloud.describeCloudError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleDelete = async (id: string, title: string) => {
    if (!window.confirm(`确定删除云端白板「${title}」？此操作不可恢复。`)) return
    try {
      await cloud.deleteBoard(id)
      await refresh()
    } catch (err) {
      setError(cloud.describeCloudError(err))
    }
  }

  return (
    <div className="wb-busy" style={{ background: 'rgba(17,24,39,0.6)' }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', color: '#111827', borderRadius: 12, padding: 20,
          width: 'min(640px, 90vw)', maxHeight: '80vh', overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 18, flex: 1 }}>云端白板</h3>
          <button className="wb-btn" style={{ background: '#e5e7eb', color: '#374151' }} onClick={refresh}>
            刷新
          </button>
          <button className="wb-btn" style={{ background: '#e5e7eb', color: '#374151' }} onClick={onClose}>
            关闭
          </button>
        </div>

        {error && (
          <div style={{ background: '#fef3c7', color: '#78350f', padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 14 }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 24, color: '#6b7280' }}>加载中…</div>
        ) : rows.length === 0 && !error ? (
          <div style={{ padding: 24, color: '#6b7280' }}>还没有云端白板。在白板里点「保存到云端」即可创建。</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map(r => (
              <li
                key={r.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 4px', borderBottom: '1px solid #f3f4f6',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title}
                  </div>
                  <div style={{ fontSize: 13, color: '#9ca3af' }}>
                    {r.pageCount} 页 · {new Date(r.updatedAt).toLocaleString('zh-CN')}
                  </div>
                </div>
                <button className="wb-btn is-primary" onClick={() => onOpen(r.id)}>
                  打开
                </button>
                <button className="wb-btn is-danger" onClick={() => handleDelete(r.id, r.title)}>
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
