// Shared helpers for the Sumo Logic Content Folders config type
// (deploy + rollback + drift + validate).
//
// A folder organizes Content Library items (Dashboards, Log Searches, Lookup
// Tables) — a SEPARATE tree from the Monitors Library used by the Monitors
// config type. There is no plain "list all folders" endpoint; folders are
// discovered by reading a known parent's `children`
// (GET /v2/content/folders/{parentId}), so every folder here declares an
// existing `parentId` (a Personal folder id — GET /v2/content/folders/personal
// — or another folder id you already manage). Deleting a folder is
// ASYNCHRONOUS — DELETE returns a job id that must be polled to completion,
// unlike every other delete in this app.
//   API: https://help.sumologic.com/docs/api/content-management/
//   Verified against the official Sumo Logic OpenAPI spec
//   (FolderDefinition / UpdateFolderRequest / Content,
//   api.sumologic.com/docs/sumologic-api.yaml).

/** A content item summary as returned inside a folder's `children` list. */
export interface ContentChild {
  id: string
  name: string
  /** Folder | Search | Report | Dashboard | Lookups. */
  itemType: string
  [key: string]: unknown
}

/** A folder read (GET /v2/content/folders/{id}), including its immediate children. */
export interface FolderResponse {
  id: string
  name: string
  description?: string
  parentId?: string
  children?: ContentChild[]
  [key: string]: unknown
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Find a Folder-type child by name (case-insensitive, trimmed) within a parent's children. */
export function findFolderChild(children: ContentChild[] | undefined, name: string): ContentChild | null {
  const n = name.trim().toLowerCase()
  if (!n || !children) return null
  return children.find((c) => c.itemType === 'Folder' && s(c.name).toLowerCase() === n) ?? null
}

/** Build the create-request body (POST /v2/content/folders). */
export function buildFolderCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return { name: s(fields.name), description: s(fields.description), parentId: s(fields.parentId) }
}

/** Build the update-request body (PUT /v2/content/folders/<id>) — no parentId (folders are moved, not re-parented here). */
export function buildFolderUpdateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return { name: s(fields.name), description: s(fields.description) }
}
