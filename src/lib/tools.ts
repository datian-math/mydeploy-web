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
