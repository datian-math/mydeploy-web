// 后端 API 基址（本地开发走 3001，线上通过 VITE_API_URL 覆盖）
export const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// 静态托管判定：GitHub Pages / Gitee Pages 都没有后端，图片必须走静态资源路径
export const IS_GITHUB_PAGES =
  typeof window !== 'undefined' && window.location.hostname.includes('github.io')

export const IS_GITEE_PAGES =
  typeof window !== 'undefined' && window.location.hostname.includes('gitee.io')

export const IS_STATIC_HOST = IS_GITHUB_PAGES || IS_GITEE_PAGES

// 兼容旧引用
export const GH_BASE = '/mydeploy-web'

// 静态托管下的资源前缀，从当前 URL 自动推断（如 /mydeploy-web、/math-site）
// 这样 GitHub Pages、Gitee Pages、换仓库名都不用改代码
export const STATIC_BASE: string = (() => {
  if (typeof window === 'undefined') return ''
  if (!IS_STATIC_HOST) return ''
  const firstSeg = (window.location.pathname || '').split('/').filter(Boolean)[0] || ''
  // 站点在域名根路径时（如自定义域名）不需要前缀
  if (!firstSeg || firstSeg.includes('.')) return ''
  return '/' + firstSeg
})()
