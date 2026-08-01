// Shared helpers for the Secret Server Folders config type (deploy + rollback +
// drift + health). Folder shapes follow the Secret Server v1 REST API
// (/api/v1/folders); verify field names against a live Secret Server instance.

import { parseJson, secretServerErrorMessage, type SecretServerClient } from '../../lib/secretServerApi'

/**
 * Secret Server addresses the root as parentFolderId -1: a top-level folder is
 * created with parentFolderId = -1. Verify against a live instance.
 */
export const ROOT_PARENT_FOLDER_ID = -1

/**
 * folderTypeId 1 is the standard "Folder" type. Verify against a live instance
 * (GET /api/v1/folders/stub returns the default folderTypeId for the tenant).
 */
export const DEFAULT_FOLDER_TYPE_ID = 1

/** One folder as returned by GET /api/v1/folders (record) or /api/v1/folders/{id}. */
export interface LiveFolder {
  id?: number | string
  folderName?: string
  parentFolderId?: number | string
  folderTypeId?: number
  inheritPermissions?: boolean
  inheritSecretPolicy?: boolean
  folderPath?: string
  [key: string]: unknown
}

/** One folder declared by a canvas item. */
export interface FolderSpec {
  folderName: string
  parentFolderName: string
  inheritPermissions: boolean
  inheritSecretPolicy: boolean
  comment: string
}

/** A canvas item shape (id/name optional; only fields are read). */
export interface CanvasItemLike {
  fields: Record<string, unknown>
}

/** Normalize a checkbox / yes-no / 1-0 value to a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

export function folderNameOf(f: LiveFolder): string {
  return String(f.folderName ?? '')
}

/** A live folder's numeric id, or null when absent / non-numeric. */
export function folderIdOf(f: LiveFolder): number | null {
  const raw = f.id
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Map canvas items to folder specs. */
export function extractFolderSpecs(items: CanvasItemLike[]): FolderSpec[] {
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      folderName: String(f.folderName ?? '').trim(),
      parentFolderName: String(f.parentFolderName ?? '').trim(),
      inheritPermissions: normalizeBool(f.inheritPermissions),
      inheritSecretPolicy: normalizeBool(f.inheritSecretPolicy),
      comment: String(f.comment ?? '').trim(),
    }
  })
}

/** Parse a folders list response — a paginated `{ records, total }` envelope or a bare array. */
export function foldersFromResponse(body: string): { records: LiveFolder[]; total?: number } {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return { records: parsed as LiveFolder[] }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { records?: unknown; total?: unknown }
    if (Array.isArray(obj.records)) {
      return { records: obj.records as LiveFolder[], total: typeof obj.total === 'number' ? obj.total : undefined }
    }
  }
  return { records: [] }
}

/**
 * GET every page of /api/v1/folders (optionally filtered by searchText),
 * concatenating `records`. Pages via skip/take (take capped at 100 by the API).
 * Throws on a non-OK response.
 */
export async function searchFolders(client: SecretServerClient, searchText?: string): Promise<LiveFolder[]> {
  const out: LiveFolder[] = []
  const take = 100
  let skip = 0
  for (let page = 0; page < 100; page++) {
    const query: Record<string, string | number> = { take, skip }
    if (searchText) query['filter.searchText'] = searchText
    const res = await client.request('GET', '/folders', { query })
    if (!res.ok) throw new Error(`Failed to list folders: ${secretServerErrorMessage(res)}`)
    const { records, total } = foldersFromResponse(res.body)
    out.push(...records)
    skip += records.length
    if (records.length < take || (total !== undefined && skip >= total)) break
  }
  return out
}

/**
 * Resolve a parent folder NAME to a parentFolderId. Blank → root
 * (ROOT_PARENT_FOLDER_ID). NON-UNION { id, error } so the platform handler loader
 * never has to narrow a discriminated union.
 */
export async function resolveParentFolderId(
  client: SecretServerClient,
  parentFolderName: string,
): Promise<{ id: number | null; error: string | null }> {
  const name = (parentFolderName ?? '').trim()
  if (!name) return { id: ROOT_PARENT_FOLDER_ID, error: null }

  const matches = await searchFolders(client, name)
  const exact = matches.filter((f) => folderNameOf(f).trim().toLowerCase() === name.toLowerCase())
  if (exact.length === 0) return { id: null, error: `Parent folder "${name}" was not found in Secret Server` }
  if (exact.length > 1) {
    return { id: null, error: `Parent folder "${name}" is ambiguous (${exact.length} folders share that name) — use a unique parent name` }
  }
  const id = folderIdOf(exact[0])
  if (id === null) return { id: null, error: `Parent folder "${name}" has no usable id` }
  return { id, error: null }
}

/** Find a live folder by name (case-insensitive) within a specific parent. */
export function findFolderByNameAndParent(folders: LiveFolder[], name: string, parentId: number): LiveFolder | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return (
    folders.find(
      (f) => folderNameOf(f).trim().toLowerCase() === n && Number(f.parentFolderId) === Number(parentId),
    ) ?? null
  )
}

/** Body for POST /api/v1/folders (create). */
export function buildFolderCreateBody(spec: FolderSpec, parentFolderId: number): Record<string, unknown> {
  return {
    folderName: spec.folderName,
    folderTypeId: DEFAULT_FOLDER_TYPE_ID,
    parentFolderId,
    inheritPermissions: spec.inheritPermissions,
    inheritSecretPolicy: spec.inheritSecretPolicy,
  }
}

/** Body for PATCH /api/v1/folders/{id} (update the managed fields). */
export function buildFolderUpdateBody(spec: FolderSpec, existing: LiveFolder): Record<string, unknown> {
  const body: Record<string, unknown> = {
    folderName: spec.folderName,
    inheritPermissions: spec.inheritPermissions,
    inheritSecretPolicy: spec.inheritSecretPolicy,
  }
  const id = folderIdOf(existing)
  if (id !== null) body.id = id
  if (existing.folderTypeId !== undefined) body.folderTypeId = existing.folderTypeId
  return body
}
