// 后端 API 基址（本地开发走 3001，线上通过 VITE_API_URL 覆盖）
export const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// GitHub Pages 部署时的静态资源前缀（图片等）
export const IS_GITHUB_PAGES =
  typeof window !== 'undefined' && window.location.hostname.includes('github.io')

export const GH_BASE = '/mydeploy-web'
