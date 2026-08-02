// Shared helpers for the runZero Scan Templates config type (deploy + rollback + drift + validate).
//
// A runZero scan template is a reusable, named set of scan parameters that a scan task can be
// based on. The console API models it as (verified against runZeroInc/runzero-api runzero-api.yml
// — ScanTemplate / ScanTemplateOptions):
//   List:    GET    /account/tasks/templates              → array of ScanTemplate
//   Create:  POST   /account/tasks/templates              body ScanTemplateOptions → ScanTemplate
//   Update:  PUT    /account/tasks/templates              body ScanTemplate (full object, id inside)
//   Delete:  DELETE /account/tasks/templates/{id}         → ScanTemplate
//
// FLAG (scope): scan templates are ACCOUNT-scoped resources shared across organizations — they
// live under /account/tasks/templates, NOT /org. So this config type requires the connection to
// carry an ACCOUNT-scoped runZero API key (broader than the Organization key the other config
// types use); an Organization key will get 401/403 here. ScanTemplateOptions.organization_id is
// required and targets the template at one org — resolved from GET /org (or an explicit field).
//
// NOTE ON VERBS: create is POST (not PUT); UPDATE is PUT on the COLLECTION with the full object
// (the id travels in the body), not PUT /{id}. DELETE is by id.

/** One runZero ScanTemplate as returned by GET /account/tasks/templates. */
export interface RunzeroScanTemplate {
  id?: string
  name?: string
  description?: string
  organization_id?: string
  global?: boolean
  acl?: Record<string, unknown>
  params?: Record<string, string>
  [key: string]: unknown
}

/** The ScanTemplateOptions request body for POST (create). */
export interface RunzeroScanTemplateOptions {
  name: string
  description: string
  organization_id: string
  global: boolean
  acl: Record<string, unknown>
  params: Record<string, string>
}

/** One entry in deploy's rollbackData.previous — what deploy did to a single template. */
export interface ScanTemplateRollbackEntry {
  name: string
  templateId: string | null
  existed: boolean
  prior: RunzeroScanTemplate | null
}

/** Trim any value to a string. */
export function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a scalar canvas value to a string (booleans/numbers included), for the params map. */
function coerceScalar(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return String(value).trim()
}

/**
 * Read a canvas `keyvalue` field into a flat string map. The control emits an array of
 * { key, value } rows; an object map and a `key=value` line string are also tolerated.
 */
export function readKeyValueMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const key = text(rec.key ?? rec.name)
        if (key) out[key] = coerceScalar(rec.value)
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const k = key.trim()
      if (k) out[k] = coerceScalar(v)
    }
    return out
  }
  if (typeof value === 'string' && value.trim()) {
    for (const line of value.split(/[\r\n,]+/)) {
      const eq = line.indexOf('=')
      if (eq > 0) {
        const k = line.slice(0, eq).trim()
        if (k) out[k] = line.slice(eq + 1).trim()
      }
    }
  }
  return out
}

/** Extract the runZero organization id from a GET /org response. */
export function orgIdFrom(org: unknown): string {
  if (org && typeof org === 'object') return text((org as { id?: unknown }).id)
  return ''
}

/** Find a live template by name (case-insensitive — the stable identity for upsert/drift). */
export function findTemplate(templates: RunzeroScanTemplate[], name: string): RunzeroScanTemplate | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return templates.find((t) => text(t.name).toLowerCase() === n) ?? null
}

/**
 * Build the ScanTemplateOptions create body from canvas fields. `organization_id` falls back to
 * the resolved org id when the operator leaves the field blank. `acl` defaults to an empty map
 * (the schema requires the key to be present), `global` to false.
 */
export function buildTemplateOptions(fields: Record<string, unknown>, resolvedOrgId: string): RunzeroScanTemplateOptions {
  return {
    name: text(fields.name),
    description: text(fields.description),
    organization_id: text(fields.organizationId) || resolvedOrgId,
    global: fields.global === true,
    acl: {},
    params: readKeyValueMap(fields.params),
  }
}

/**
 * Build the full ScanTemplate PUT (update) body: the prior object with the declared fields
 * layered on top, preserving id / client_id / acl the update requires.
 */
export function buildTemplateUpdate(
  prior: RunzeroScanTemplate,
  fields: Record<string, unknown>,
  resolvedOrgId: string,
): RunzeroScanTemplate {
  return {
    ...prior,
    name: text(fields.name) || prior.name,
    description: text(fields.description),
    organization_id: text(fields.organizationId) || prior.organization_id || resolvedOrgId,
    global: fields.global === true,
    acl: prior.acl ?? {},
    params: readKeyValueMap(fields.params),
  }
}

/** True when two params maps describe the same set of key→value pairs. */
export function paramsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => a[k] === b[k])
}
