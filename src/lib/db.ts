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

// ===== Categories =====

export async function fetchCategories() {
  const { data, error } = await supabase.from('math_categories').select('*').order('id')
  if (error) { console.error('fetchCategories:', error); return [] }
  return data || []
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
