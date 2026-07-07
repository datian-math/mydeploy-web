import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth.tsx'
import './index.css'
import App from './App.tsx'
import Login from './pages/Login.tsx'

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; errorInfo: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, errorInfo: '' }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorInfo: error.toString() + '\n\n' + (error.stack || '') }
  }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({
      hasError: true,
      errorInfo: error.toString() + '\n\n' + (errorInfo.componentStack || '') + '\n\n' + (error.stack || '')
    })
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace', color: '#c00', background: '#fee', minHeight: '100vh' }}>
          <h2>🚨 React 渲染错误</h2>
          <pre style={{ background: '#fff', padding: 16, borderRadius: 8, overflow: 'auto', maxHeight: '80vh', whiteSpace: 'pre-wrap', fontSize: 12 }}>
            {this.state.errorInfo}
          </pre>
          <button onClick={() => window.location.reload()} style={{ marginTop: 16, padding: '8px 24px', background: '#c00', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            刷新页面
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function ProtectedApp() {
  const { user, allowed, loading } = useAuth()

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: '"Noto Sans SC", sans-serif', color: '#999' }}>加载中...</div>
  }

  if (!user || !allowed) {
    return <Navigate to="/login" replace />
  }

  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/*" element={<ProtectedApp />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
