import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { signIn, user, allowed, loading: authLoading } = useAuth()
  const navigate = useNavigate()

  // Auto-redirect when logged in
  useEffect(() => {
    if (!authLoading && user && allowed) {
      navigate('/', { replace: true })
    }
  }, [authLoading, user, allowed, navigate])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    console.log('Login submit triggered')
    setError('')
    setLoading(true)

    try {
      const { error: signInError } = await signIn(email, password)
      if (signInError) {
        console.log('Login error:', signInError)
        setError(signInError.message === 'Invalid login credentials' ? '邮箱或密码错误' : signInError.message)
      } else {
        console.log('Login success')
      }
    } catch (err: any) {
      console.log('Login exception:', err)
      setError('登录异常: ' + (err.message || '未知错误'))
    }
    setLoading(false)
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      fontFamily: '"Noto Sans SC", sans-serif',
    }}>
      <div style={{
        background: '#fff',
        borderRadius: 16,
        padding: '40px 32px',
        width: 380,
        boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
      }}>
        <h1 style={{ textAlign: 'center', fontSize: 22, fontWeight: 700, color: '#333', marginBottom: 4 }}>
          大田的数学空间
        </h1>
        <p style={{ textAlign: 'center', fontSize: 13, color: '#999', marginBottom: 28 }}>
          登录以继续
        </p>

        <form onSubmit={handleSubmit}>
          {error && (
            <div style={{
              background: '#fef2f2', color: '#dc2626', fontSize: 13,
              padding: '8px 12px', borderRadius: 8, marginBottom: 16,
            }}>{error}</div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 13, fontWeight: 500, color: '#555', display: 'block', marginBottom: 6 }}>邮箱</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)} required
              placeholder="your@email.com"
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '10px 14px', borderRadius: 8, border: '1px solid #ddd',
                fontSize: 14, outline: 'none',
              }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ fontSize: 13, fontWeight: 500, color: '#555', display: 'block', marginBottom: 6 }}>密码</label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)} required
              placeholder="••••••••"
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '10px 14px', borderRadius: 8, border: '1px solid #ddd',
                fontSize: 14, outline: 'none',
              }}
            />
          </div>

          <button
            type="submit" disabled={loading}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '12px', borderRadius: 8,
              background: loading ? '#a78bfa' : '#534AB7',
              color: '#fff', border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: 15, fontWeight: 600,
            }}
          >
            {loading ? '登录中...' : '登 录'}
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: 12, color: '#bbb', marginTop: 24 }}>
          需要管理员添加账号后才能登录
        </p>
      </div>
    </div>
  )
}
