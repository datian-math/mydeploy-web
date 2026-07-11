import { supabase } from './supabase'

// ===== Questions =====

export interface Question {
  id: string
  type: string
  content: string
  answer?: string
  solution?: string
  difficulty?: number
  category: string
  subcategory?: string
  topic?: string
  tags?: string[]
  image?: string
  grade?: string
  source?: string
  created_at?: string
  updated_at?: string
}

// 难度映射
const DIFF_TO_INT: Record<string, number> = { '易': 1, '中': 3, '难': 5 }
const INT_TO_DIFF: Record<number, string> = { 1: '易', 2: '中', 3: '中', 4: '难', 5: '难' }

// Supabase → 前端用的格式
export function toFrontendQuestion(q: Question) {
  // 修复高考题图片路径（无后端时用相对路径）
  const fixImgPath = (s: string) => s.replace(/\/api\/exam-images\//g, './exam-images/')
  return {
    id: q.id,
    title: '',
    content: fixImgPath(q.content || ''),
    answer: q.answer || '',
    answerContent: '',
    analysis: fixImgPath(q.solution || ''),
    options: [] as string[],
    difficulty: INT_TO_DIFF[q.difficulty || 3] || '中',
    type: q.type || '解答',
    grade: q.grade || '',
    categoryId: q.subcategory || '',
    categoryName: q.category || '未分类',
    tags: Array.isArray(q.tags) ? q.tags : [],
    source: q.source || '',
    images: q.image ? JSON.parse(q.image) : {} as Record<string, string>,
    createdAt: q.created_at || '',
  }
}

// 前端格式 → Supabase
export function toSupabaseQuestion(q: any) {
  return {
    id: q.id,
    type: q.type || '解答',
    content: q.content || '',
    answer: q.answer || '',
    solution: q.analysis || '',
    difficulty: typeof q.difficulty === 'string' ? (DIFF_TO_INT[q.difficulty] || 3) : (parseInt(q.difficulty) || 3),
    category: q.categoryName || q.category || '未分类',
    subcategory: q.categoryId || '',
    topic: q.topic || '',
    tags: Array.isArray(q.tags) ? q.tags : [],
    grade: q.grade || '',
    source: q.source || '',
    image: q.images && Object.keys(q.images || {}).length > 0 ? JSON.stringify(q.images) : null,
    updated_at: new Date().toISOString()
  }
}

export async function fetchQuestions(filters?: {
  category?: string
  subcategory?: string
  topic?: string
  type?: string
  difficulty?: number
  search?: string
}) {
  let query = supabase.from('math_questions').select('*')

  if (filters?.category) query = query.eq('category', filters.category)
  if (filters?.subcategory) query = query.eq('subcategory', filters.subcategory)
  if (filters?.topic) query = query.eq('topic', filters.topic)
  if (filters?.type) query = query.eq('type', filters.type)
  if (filters?.difficulty) query = query.eq('difficulty', filters.difficulty)
  if (filters?.search) query = query.ilike('content', `%${filters.search}%`)

  query = query.order('created_at', { ascending: false })
  const { data, error } = await query
  if (error) { console.error('fetchQuestions:', error); return [] }
  return (data || []) as Question[]
}

export async function fetchQuestion(id: string) {
  const { data, error } = await supabase.from('math_questions').select('*').eq('id', id).single()
  if (error) { console.error('fetchQuestion:', error); return null }
  return data as Question
}

export async function createQuestion(q: any) {
  const row = toSupabaseQuestion(q)
  if (!row.id) row.id = 'q-' + Date.now()
  const { error } = await supabase.from('math_questions').insert(row)
  if (error) { console.error('createQuestion:', error); return false }
  return true
}

export async function updateQuestion(id: string, updates: any) {
  const supabaseUpdates: any = {}
  if (updates.content !== undefined) supabaseUpdates.content = updates.content
  if (updates.answer !== undefined) supabaseUpdates.answer = updates.answer
  if (updates.analysis !== undefined) supabaseUpdates.solution = updates.analysis
  if (updates.solution !== undefined) supabaseUpdates.solution = updates.solution
  if (updates.difficulty !== undefined) supabaseUpdates.difficulty = typeof updates.difficulty === 'string' ? (DIFF_TO_INT[updates.difficulty] || 3) : updates.difficulty
  if (updates.type !== undefined) supabaseUpdates.type = updates.type
  if (updates.grade !== undefined) supabaseUpdates.grade = updates.grade
  if (updates.categoryId !== undefined) supabaseUpdates.subcategory = updates.categoryId
  if (updates.categoryName !== undefined) supabaseUpdates.category = updates.categoryName
  if (updates.category !== undefined) supabaseUpdates.category = updates.category
  if (updates.tags !== undefined) supabaseUpdates.tags = Array.isArray(updates.tags) ? updates.tags : []
  if (updates.source !== undefined) supabaseUpdates.source = updates.source
  if (updates.images !== undefined) supabaseUpdates.image = updates.images && Object.keys(updates.images).length > 0 ? JSON.stringify(updates.images) : null
  supabaseUpdates.updated_at = new Date().toISOString()

  const { error } = await supabase.from('math_questions').update(supabaseUpdates).eq('id', id)
  if (error) { console.error('updateQuestion:', error); return false }
  return true
}

export async function deleteQuestion(id: string) {
  const { error } = await supabase.from('math_questions').delete().eq('id', id)
  if (error) { console.error('deleteQuestion:', error); return false }
  return true
}

// ===== Categories =====

export interface SupabaseCategory {
  id: string
  name: string
  subcategories?: { id: string; name: string }[]
}

export async function fetchCategories() {
  const { data, error } = await supabase.from('math_categories').select('*').order('id')
  if (error) { console.error('fetchCategories:', error); return [] }
  // Supabase 存的是 {id, name, subcategories: [{id, name}]}，转为树形 {id, name, children}
  return (data || []).map((c: any) => ({
    id: c.id,
    name: c.name,
    children: (c.subcategories || []).map((s: any) => ({ id: s.id, name: s.name }))
  }))
}

// ===== Basket =====

export async function fetchBasket() {
  const { data, error } = await supabase.from('math_baskets').select('question_id')
  if (error) { console.error('fetchBasket:', error); return [] }
  return (data || []).map((row: any) => row.question_id)
}

export async function addToBasket(questionId: string) {
  const { error } = await supabase.from('math_baskets')
    .upsert({ question_id: questionId })
  if (error) console.error('addToBasket:', error)
}

export async function removeFromBasket(questionId: string) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  const { error } = await supabase.from('math_baskets')
    .delete()
    .eq('user_id', user.id)
    .eq('question_id', questionId)
  if (error) console.error('removeFromBasket:', error)
}

export async function clearBasket() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  const { error } = await supabase.from('math_baskets')
    .delete()
    .eq('user_id', user.id)
  if (error) console.error('clearBasket:', error)
}

// ===== Papers (downloaded) =====

export interface Paper {
  id: string
  title: string
  question_ids: string[]
  created_at: string
}

export async function fetchPapers() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []
  const { data, error } = await supabase.from('math_papers')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
  if (error) { console.error('fetchPapers:', error); return [] }
  return (data || []) as Paper[]
}

export async function savePaper(title: string, questionIds: string[]) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data, error } = await supabase.from('math_papers')
    .insert({ user_id: user.id, title, question_ids: questionIds })
    .select()
    .single()
  if (error) { console.error('savePaper:', error); return null }
  return data
}
