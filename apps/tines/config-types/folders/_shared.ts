// Shared helpers for the Tines Folders config type
// (validate + deploy + rollback + drift + health).
//
// A Tines folder lives at /api/v1/folders. Its true identity is the tuple
// (team_id, content_type, parent_folder_id, name) — Tines allows the same
// name in different scopes — so every helper here takes the scope alongside
// the name.
//
// Docs (fetched 2026-08-05): https://www.tines.com/api/folders
//   list:   GET    /api/v1/folders?team_id=&content_type=  -> { folders: [...], meta }
//   create: POST   /api/v1/folders   <- { name, content_type, team_id, parent_folder_id }
//   get:    GET    /api/v1/folders/{id}
//   update: PUT    /api/v1/folders/{id}  <- { name, parent_folder_id }
//   delete: DELETE /api/v1/folders/{id}

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const CONTENT_TYPES = ['STORY', 'CREDENTIAL', 'RESOURCE'] as const
export type ContentType = (typeof CONTENT_TYPES)[number]

/** A folder as returned by the Tines Folders API. */
export interface LiveFolder {
  id?: number | string
  name?: string
  team_id?: number | string
  content_type?: string
  parent_folder_id?: number | string | null
  size?: number
}

/** One canvas item, normalized to the fields this config type manages. */
export interface FolderSpec {
  itemName: string
  name: string
  teamId: string
  contentType: string
  parentFolderName: string
}

export function extractFolderSpecs(canvas: CanvasSnapshot): FolderSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      teamId: typeof fields.team_id === 'string' ? fields.team_id.trim() : String(fields.team_id ?? '').trim(),
      contentType: typeof fields.content_type === 'string' ? fields.content_type.trim() : '',
      parentFolderName: typeof fields.parent_folder_name === 'string' ? fields.parent_folder_name.trim() : '',
    }
  })
}

/** Build the request body for POST/PUT /folders. */
export function buildFolderBody(
  spec: FolderSpec,
  parentFolderId: string | null,
): { name: string; content_type?: string; team_id?: string; parent_folder_id: string | null } {
  return {
    name: spec.name,
    content_type: spec.contentType,
    team_id: spec.teamId,
    parent_folder_id: parentFolderId,
  }
}

/**
 * Find a live folder matching (team, content type, parent, name) — the true
 * reconciliation identity. `parentFolderId` is null for a root-level folder.
 */
export function findFolder(
  folders: LiveFolder[],
  spec: { teamId: string; contentType: string; name: string },
  parentFolderId: string | null,
): LiveFolder | null {
  const name = spec.name.trim().toLowerCase()
  if (!name) return null
  return (
    folders.find(
      (f) =>
        String(f.team_id ?? '') === spec.teamId &&
        String(f.content_type ?? '') === spec.contentType &&
        String(f.name ?? '').trim().toLowerCase() === name &&
        String(f.parent_folder_id ?? '') === String(parentFolderId ?? ''),
    ) ?? null
  )
}

/** Find a live folder by (team, content type, name) only — used to resolve a parent by name. */
export function findFolderByName(
  folders: LiveFolder[],
  teamId: string,
  contentType: string,
  name: string,
): LiveFolder | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return (
    folders.find(
      (f) =>
        String(f.team_id ?? '') === teamId &&
        String(f.content_type ?? '') === contentType &&
        String(f.name ?? '').trim().toLowerCase() === n,
    ) ?? null
  )
}
