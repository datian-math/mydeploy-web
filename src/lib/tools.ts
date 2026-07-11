import { supabase } from './supabase'

// ===== Links =====
export async function fetchLinks() {
  const { data, error } = await supabase.from('math_tool_links').select('*').order('created_at', { ascending: false })
  if (error) { console.error('fetchLinks:', error); return [] }
  return data || []
}

export async function addLink(name: string, url: string) {
  const { error } = await supabase.from('math_tool_links').insert({ name, url })
  if (error) { console.error('addLink:', error); return false }
  return true
}

export async function deleteLink(id: number) {
  const { error } = await supabase.from('math_tool_links').delete().eq('id', id)
  if (error) { console.error('deleteLink:', error); return false }
  return true
}

// ===== Commands =====
export async function fetchCommands() {
  const { data, error } = await supabase.from('math_tool_commands').select('*').order('created_at', { ascending: false })
  if (error) { console.error('fetchCommands:', error); return [] }
  return data || []
}

export async function addCommand(name: string, category: string, content: string) {
  const { error } = await supabase.from('math_tool_commands').insert({ name, category, content })
  if (error) { console.error('addCommand:', error); return false }
  return true
}

export async function deleteCommand(id: number) {
  const { error } = await supabase.from('math_tool_commands').delete().eq('id', id)
  if (error) { console.error('deleteCommand:', error); return false }
  return true
}

// ===== Installers =====
export async function fetchInstallers() {
  const { data, error } = await supabase.from('math_tool_installers').select('*').order('created_at', { ascending: false })
  if (error) { console.error('fetchInstallers:', error); return [] }
  return data || []
}

export async function uploadInstaller(name: string, file: File) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false

  const filePath = `installers/${user.id}/${Date.now()}_${file.name}`
  const { error: uploadError } = await supabase.storage.from('post-photos').upload(filePath, file)
  if (uploadError) { console.error('uploadInstaller upload:', uploadError); return false }

  const { data: urlData } = supabase.storage.from('post-photos').getPublicUrl(filePath)

  const { error: dbError } = await supabase.from('math_tool_installers').insert({
    name, file_name: file.name, file_path: urlData.publicUrl, size: file.size
  })
  if (dbError) { console.error('uploadInstaller db:', dbError); return false }
  return true
}

export async function deleteInstaller(id: number) {
  const { error } = await supabase.from('math_tool_installers').delete().eq('id', id)
  if (error) { console.error('deleteInstaller:', error); return false }
  return true
}

// ===== Exam Papers =====
export async function fetchExamPapers() {
  const { data, error } = await supabase.from('math_exam_papers').select('*').order('created_at', { ascending: false })
  if (error) { console.error('fetchExamPapers:', error); return [] }
  return data || []
}

export async function uploadExamPaper(title: string, file: File) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false

  // 清理文件名：去空格、去中文、只保留安全字符
  const ext = file.name.substring(file.name.lastIndexOf('.'))
  const safeName = file.name
    .replace(/\.[^.]+$/, '')  // 去扩展名
    .replace(/[^\x00-\x7F]/g, '')  // 去非 ASCII（中文等）
    .replace(/[\s()（）]+/g, '_')  // 空格和括号换下划线
    .replace(/[^a-zA-Z0-9_.-]/g, '')  // 只保留安全字符
    .substring(0, 50)  // 限制长度
  const cleanName = (safeName || 'file') + '_' + Date.now() + ext

  const filePath = `exams/${user.id}/${cleanName}`
  const { error: uploadError } = await supabase.storage.from('post-photos').upload(filePath, file)
  if (uploadError) { console.error('uploadExamPaper:', uploadError); return false }

  const { data: urlData } = supabase.storage.from('post-photos').getPublicUrl(filePath)

  const { error: dbError } = await supabase.from('math_exam_papers').insert({
    title, file_name: file.name, file_path: urlData.publicUrl, size: file.size
  })
  if (dbError) { console.error('uploadExamPaper db:', dbError); return false }
  return true
}

export async function deleteExamPaper(id: number) {
  const { error } = await supabase.from('math_exam_papers').delete().eq('id', id)
  if (error) { console.error('deleteExamPaper:', error); return false }
  return true
}
