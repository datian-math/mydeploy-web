import React, { useState, useEffect } from 'react'

const API = 'http://localhost:3001'

interface PaperRecord {
  id: string
  title: string
  filename: string
  size: number
  createdAt: string
  questionCount: number
  includeAnswer: boolean
  includeAnalysis: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function DownloadedPapers() {
  const [papers, setPapers] = useState<PaperRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewFullscreen, setPreviewFullscreen] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchPapers()
  }, [])

  async function fetchPapers() {
    try {
      setLoading(true)
      const res = await fetch(`${API}/api/papers`)
      if (!res.ok) throw new Error('获取失败')
      const data = await res.json()
      setPapers(data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id: string, title: string) {
    if (!confirm(`确定要删除「${title}」吗？删除后不可恢复。`)) return
    try {
      const res = await fetch(`${API}/api/papers/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('删除失败')
      setPapers(prev => prev.filter(p => p.id !== id))
    } catch (e: any) {
      alert('删除失败：' + e.message)
    }
  }

  function handlePreview(id: string) {
    setPreviewId(id)
  }

  function handleDownload(id: string, filename: string) {
    const url = `${API}/api/papers/${id}/file`
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#666' }}>加载中...</div>
  }

  if (error) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#c00' }}>加载失败：{error}</div>
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px' }}>
      {/* 标题栏 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>已下载的试卷</h2>
        <button
          onClick={fetchPapers}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid #e0e0e0',
            background: '#fff',
            cursor: 'pointer',
            fontSize: 13,
            color: '#534AB7'
          }}
        >
          刷新
        </button>
      </div>

      {papers.length === 0 ? (
        <div style={{
          background: '#fff',
          borderRadius: 12,
          border: '0.5px solid #e8e8e4',
          padding: 60,
          textAlign: 'center',
          color: '#999'
        }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📄</div>
          <div style={{ fontSize: 15 }}>暂无已下载的试卷</div>
          <div style={{ fontSize: 13, marginTop: 8, color: '#bbb' }}>在「新版组卷」或「旧版组卷」中导出 PDF 后，试卷会出现在这里</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {papers.map(paper => (
            <div
              key={paper.id}
              style={{
                background: '#fff',
                borderRadius: 10,
                border: '0.5px solid #e8e8e4',
                padding: '16px 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                transition: 'box-shadow 0.2s',
              }}
              onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)')}
              onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
            >
              {/* 左侧信息 */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 500, color: '#333', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {paper.title}
                  {paper.includeAnswer && <span style={{ marginLeft: 8, fontSize: 11, color: '#27ae60', background: '#e8f5e9', padding: '1px 6px', borderRadius: 4 }}>含答案</span>}
                </div>
                <div style={{ fontSize: 12, color: '#999', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {paper.questionCount > 0 && <span>{paper.questionCount} 题</span>}
                  {paper.size > 0 && <span>{formatSize(paper.size)}</span>}
                  <span>{formatDate(paper.createdAt)}</span>
                </div>
              </div>

              {/* 右侧操作按钮 */}
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  onClick={() => handlePreview(paper.id)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    border: '1px solid #534AB7',
                    background: '#fff',
                    color: '#534AB7',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 500
                  }}
                >
                  预览
                </button>
                <button
                  onClick={() => handleDownload(paper.id, paper.filename)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    border: '1px solid #534AB7',
                    background: '#534AB7',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 500
                  }}
                >
                  下载
                </button>
                <button
                  onClick={() => handleDelete(paper.id, paper.title)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    border: '1px solid #e0e0e0',
                    background: '#fff',
                    color: '#c00',
                    cursor: 'pointer',
                    fontSize: 13
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* PDF 预览弹窗 */}
      {previewId && (
        <div
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            background: previewFullscreen ? '#fff' : 'rgba(0,0,0,0.5)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: previewFullscreen ? 0 : 20,
            transition: 'all 0.2s'
          }}
          onClick={() => { setPreviewId(null); setPreviewFullscreen(false); }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: previewFullscreen ? 0 : 12,
              width: previewFullscreen ? '100%' : '90%',
              maxWidth: previewFullscreen ? '100%' : 900,
              height: previewFullscreen ? '100vh' : '85vh',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              boxShadow: previewFullscreen ? 'none' : '0 8px 32px rgba(0,0,0,0.2)',
              transition: 'all 0.2s'
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* 弹窗头部 */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 20px',
              borderBottom: '1px solid #eee',
              flexShrink: 0
            }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>PDF 预览</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={() => setPreviewFullscreen(!previewFullscreen)}
                  title={previewFullscreen ? '退出全屏' : '全屏'}
                  style={{
                    background: 'none',
                    border: '1px solid #ddd',
                    borderRadius: 4,
                    fontSize: 16,
                    cursor: 'pointer',
                    color: '#666',
                    lineHeight: 1,
                    padding: '4px 8px'
                  }}
                >
                  {previewFullscreen ? '🗗' : '🗖'}
                </button>
                <button
                  onClick={() => { setPreviewId(null); setPreviewFullscreen(false); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: 22,
                    cursor: 'pointer',
                    color: '#999',
                    lineHeight: 1
                  }}
                >
                  &times;
                </button>
              </div>
            </div>
            {/* PDF iframe */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <iframe
                src={`${API}/api/papers/${previewId}/file?preview=1`}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="PDF预览"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
