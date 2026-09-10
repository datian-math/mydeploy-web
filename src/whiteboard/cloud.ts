// 白板云保存（Supabase）
// 设计约束：
//  - 只在「退出白板 / 手动保存」时上传，不跟着自动保存打请求（教室网络差会堆积）
//  - 所有调用都要 try/catch 优雅降级：表不存在、离线、超时都不能影响上课
//  - 需要先在 Supabase 执行 math_whiteboards 建表 SQL（见 supabase-migration.sql）
import { supabase } from '../lib/supabase'
import type { BoardDoc, BoardItem } from './types'

const TABLE = 'math_whiteboards'
/** 每个用户最多保留的白板数 */
export const MAX_BOARDS_PER_USER = 20

export interface CloudBoardSummary {
  id: string
  title: string
  updatedAt: string
  pageCount: number
}

export interface CloudBoardPayload {
  items: BoardItem[]
  doc: BoardDoc
}

interface Row {
  id: string
  title: string
  data: CloudBoardPayload
  created_at: string
  updated_at: string
}

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  // PGRST205: schema cache 里没有这张表；42P01: Postgres undefined_table
  return err.code === 'PGRST205' || err.code === '42P01' ||
    /does not exist|Could not find the table/i.test(err.message || '')
}

export class CloudUnavailableError extends Error {
  constructor() {
    super('云端白板表尚未创建')
    this.name = 'CloudUnavailableError'
  }
}

/** 列出当前用户的白板（按更新时间倒序） */
export async function listBoards(): Promise<CloudBoardSummary[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id,title,updated_at,data')
    .order('updated_at', { ascending: false })
    .limit(MAX_BOARDS_PER_USER)
  if (error) {
    if (isMissingTable(error)) throw new CloudUnavailableError()
    throw new Error(error.message)
  }
  return (data || []).map((r: any) => ({
    id: r.id,
    title: r.title || '未命名白板',
    updatedAt: r.updated_at,
    pageCount: Array.isArray(r.data?.items) ? r.data.items.length : 0,
  }))
}

/** 读取一块白板 */
export async function loadBoard(id: string): Promise<CloudBoardPayload> {
  const { data, error } = await supabase.from(TABLE).select('data').eq('id', id).single()
  if (error) {
    if (isMissingTable(error)) throw new CloudUnavailableError()
    throw new Error(error.message)
  }
  const payload = (data as Row | null)?.data
  if (!payload || !Array.isArray(payload.items) || !payload.doc) {
    throw new Error('云端白板数据格式不正确')
  }
  return payload
}

/** 新建一块白板，返回 id */
export async function createBoard(
  title: string,
  payload: CloudBoardPayload,
  userId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ user_id: userId, title, data: payload })
    .select('id')
    .single()
  if (error) {
    if (isMissingTable(error)) throw new CloudUnavailableError()
    throw new Error(error.message)
  }
  return (data as { id: string }).id
}

/** 覆盖更新一块白板 */
export async function updateBoard(
  id: string,
  title: string,
  payload: CloudBoardPayload,
): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ title, data: payload, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    if (isMissingTable(error)) throw new CloudUnavailableError()
    throw new Error(error.message)
  }
}

/** 保存（有 id 则更新，否则新建）。返回白板 id */
export async function saveBoard(
  id: string | null,
  title: string,
  payload: CloudBoardPayload,
  userId: string,
): Promise<string> {
  if (id) {
    await updateBoard(id, title, payload)
    return id
  }
  return createBoard(title, payload, userId)
}

export async function deleteBoard(id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('id', id)
  if (error) {
    if (isMissingTable(error)) throw new CloudUnavailableError()
    throw new Error(error.message)
  }
}

/** 把异常翻译成给老师看的提示语 */
export function describeCloudError(err: unknown): string {
  if (err instanceof CloudUnavailableError) {
    return '云端功能还没启用（需要先在 Supabase 建表），本次板书已保存在本机'
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/fetch|network|timeout|Failed to fetch/i.test(msg)) {
    return '网络不通，云端保存失败。本次板书已保存在本机'
  }
  return `云端保存失败：${msg}。本次板书已保存在本机`
}
