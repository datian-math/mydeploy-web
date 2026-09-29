// 后端 API 基址（本地开发走 3001，线上通过 VITE_API_URL 覆盖）
export const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const HOST = typeof window !== 'undefined' ? window.location.hostname : ''
const IS_LOCAL = !HOST || HOST === 'localhost' || HOST === '127.0.0.1' || HOST === '0.0.0.0'

// 静态托管判定：只有本地开发才带后端，除此之外（GitHub Pages / Gitee / jsDelivr / unpkg / 自定义域名）
// 都没有后端，图片一律走静态资源路径
export const IS_STATIC_HOST = !IS_LOCAL

// 兼容旧引用
export const IS_GITHUB_PAGES = HOST.includes('github.io')
export const IS_GITEE_PAGES = HOST.includes('gitee.io')
export const GH_BASE = '/mydeploy-web'

// 静态托管下的资源前缀：取 index.html 所在目录
//   /mydeploy-web/            -> /mydeploy-web
//   /math-site/index.html     -> /math-site
//   /npm/pkg@1.0.0/index.html -> /npm/pkg@1.0.0
//   /                         -> （根路径，无前缀）
export const STATIC_BASE: string = (() => {
  if (typeof window === 'undefined' || !IS_STATIC_HOST) return ''
  const segs = (window.location.pathname || '/').split('/').filter(Boolean)
  if (segs.length && /\.[A-Za-z0-9]+$/.test(segs[segs.length - 1])) segs.pop() // 去掉 index.html
  return segs.length ? '/' + segs.join('/') : ''
})()
