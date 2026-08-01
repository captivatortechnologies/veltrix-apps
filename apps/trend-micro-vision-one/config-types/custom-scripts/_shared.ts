// Shared helpers for the Trend Vision One Custom Scripts config type (the
// Response Management custom-script library) — deploy + rollback + drift.
//
// Endpoint paths + body shapes follow the Trend Vision One public API v3.0
// (Response Management -> Custom Scripts). All paths are CONFIRMED against the
// official Trend `pytmv1` SDK (trendmicro/tm-v1-pytv1, model/enum.py +
// api/script.py): list/add share /response/customScripts; update is
// /response/customScripts/{id}/update; download (GET) and delete (DELETE) are
// /response/customScripts/{id}. Add/update are multipart/form-data — `fileType`
// and `description` are form fields and the script is a `file` part. VERIFY the
// exact field names + list-response envelope against a live Vision One tenant.

/** List all custom scripts. GET; returns { items: [...], nextLink }. CONFIRMED. */
export const CUSTOM_SCRIPT_LIST = '/response/customScripts'
/** Add a custom script. POST multipart (fileType, description?, file). Returns { id }. CONFIRMED. */
export const CUSTOM_SCRIPT_ADD = '/response/customScripts'

/** Update path for a script id. POST multipart. CONFIRMED (UPDATE_CUSTOM_SCRIPT). */
export function scriptUpdatePath(id: string): string {
  return `/response/customScripts/${encodeURIComponent(id)}/update`
}
/** Per-script path used for download (GET, returns script text) and delete (DELETE). CONFIRMED. */
export function scriptItemPath(id: string): string {
  return `/response/customScripts/${encodeURIComponent(id)}`
}

/** Accepted script file types. CONFIRMED (pytmv1 ScriptType enum). */
export const SCRIPT_FILE_TYPES = new Set(['powershell', 'bash'])

/** The file extension Vision One expects for a given script type (.ps1 / .sh). */
export function expectedExtension(fileType: string): '.ps1' | '.sh' | null {
  if (fileType === 'powershell') return '.ps1'
  if (fileType === 'bash') return '.sh'
  return null
}

/** True when the file name's extension matches the declared script type. */
export function fileNameMatchesType(fileName: string, fileType: string): boolean {
  const ext = expectedExtension(fileType)
  if (!ext) return false
  return fileName.trim().toLowerCase().endsWith(ext)
}

/**
 * One custom script as read back from the list endpoint. Identity for
 * config-as-code is the `fileName`; the server also assigns an opaque `id` used
 * for update / download / delete. VERIFY field names against a live tenant.
 */
export interface CustomScript {
  id?: string
  fileName?: string
  fileType?: string
  description?: string
  [key: string]: unknown
}

/**
 * Vision One list responses carry the scripts on `items` (with a `nextLink` for
 * pagination). Accept either that shape or a bare array. VERIFY against live
 * Vision One.
 */
export function scriptsFromResponse(json: unknown): CustomScript[] {
  if (Array.isArray(json)) return json as CustomScript[]
  if (json && typeof json === 'object') {
    const items = (json as Record<string, unknown>).items
    if (Array.isArray(items)) return items as CustomScript[]
  }
  return []
}

/** Find a live script by its (trimmed) file name — the config-as-code identity. */
export function findScriptByFileName(scripts: CustomScript[], fileName: string): CustomScript | null {
  const target = fileName.trim()
  if (!target) return null
  return scripts.find((s) => String(s.fileName ?? '').trim() === target) ?? null
}

/** The parsed canvas fields for one custom script. */
export interface ScriptFields {
  fileName: string
  fileType: string
  content: string
  description: string
}

/**
 * Parse a canvas item's fields into a script definition. Returns null when the
 * required file name, file type or content is missing (deploy skips such items).
 */
export function parseScriptFields(fields: Record<string, unknown>): ScriptFields | null {
  const fileName = String(fields.fileName ?? '').trim()
  const fileType = String(fields.fileType ?? '').trim()
  const content = String(fields.scriptContent ?? '')
  const description = String(fields.description ?? '').trim()
  if (!fileName || !SCRIPT_FILE_TYPES.has(fileType) || !content.trim()) return null
  return { fileName, fileType, content, description }
}

/** The multipart form fields (metadata) for an add / update call. */
export function scriptFormFields(script: ScriptFields): Record<string, string> {
  const fields: Record<string, string> = { fileType: script.fileType }
  if (script.description) fields.description = script.description
  return fields
}

/**
 * Normalize script text for drift comparison: unify CRLF -> LF and trim trailing
 * whitespace so a benign line-ending difference is not reported as drift.
 */
export function normalizeContent(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/g, '')
}

/**
 * The Vision One custom-script add returns the new script id on the `Location`
 * response header (201 Created), not the body — extract its last path segment.
 * Confirmed against the pytmv1 AddCustomScriptResp model. Returns null when absent.
 */
export function idFromLocation(headers: Record<string, string>): string | null {
  const loc = (headers.location ?? '').trim().replace(/\/+$/, '')
  if (!loc) return null
  const id = loc.split('/').pop()
  return id ? decodeURIComponent(id) : null
}
