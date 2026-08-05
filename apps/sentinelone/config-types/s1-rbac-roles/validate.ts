import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SentinelOne RBAC role constraints ----------------------------------------
// Source: SentinelOne Management API v2.1 RBAC family:
//   GET  /rbac/roles        — list roles (name/description/scope; no permissions)
//   GET  /rbac/role/{id}    — a single role's full detail, including permissions
//   GET  /rbac/role         — the PERMISSION TEMPLATE for a NEW role at a scope
//   POST/PUT/DELETE /rbac/roles — create/update/delete (1 endpoint each; the
//     simplest write shape in this app's whole researched surface, unlike the
//     multi-action families under /firewall-control and /sites)
// Source: Celerium/SentinelOne-PowerShellWrapper `Get-SentinelOneRBACRoles` /
// `Get-SentinelOneRBACRoleTemplate` (confirms the three GET endpoints above and
// the account/site/group/tenant scope model).
//
// SentinelOne's own custom-RBAC feature ("Feature Spotlight: Fully Custom
// Role-Based Access Control") lets an admin toggle a large, product-specific
// permission tree per role. This app does not hardcode that tree (it is deep,
// versioned per tenant/SKU, and not documented in any source found) — instead
// it mirrors the EXISTING s1-agent-policy config type's read-merge-write
// pattern: authors declare only the dot-path permission keys they want to set
// (discovered from their own tenant's `GET /rbac/role` template or an existing
// role's `GET /rbac/role/{id}` detail), and deploy merges just those keys into
// whatever the live template/role already has, never guessing at the rest of
// the tree. See config-types/s1-rbac-roles/deploy.ts for the merge mechanics.

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RbacRoleSpec {
  sectionName: string
  name: string
  description?: string
  /** Dot-path permission key -> coerced value (boolean/number/string). */
  permissions: Record<string, unknown>
}

/** Shape of a role returned by GET /rbac/roles (list — no permissions). */
export interface LiveRbacRole {
  id?: string
  name?: string
  description?: string
}

/** Shape of a role returned by GET /rbac/role/{id} or the GET /rbac/role template. */
export interface LiveRbacRoleDetail {
  name?: string
  description?: string
  permissions?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * The role's logical identity at a scope: its name. Case-insensitive and
 * trimmed, matching how this app already reconciles SentinelOne STAR rules,
 * Firewall Control and Device Control rules.
 */
export function roleKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Read a string field: trimmed, or "" when unset / not a string. */
function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Coerce a raw keyvalue entry to a string (objects/arrays are JSON-stringified). */
function coerceScalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Read a `keyvalue` field into a plain string map. Tolerates the shapes the
 * canvas control (or an imported config) can emit: an object ({ k: v }), an
 * array of `{ key|name, value }` pairs, or a newline/comma-separated "k=v"
 * string. Blank keys are dropped; later entries win on a key collision.
 */
export function readKeyValueMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const key = readString(rec.key ?? rec.name)
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
      const idx = line.indexOf('=')
      if (idx > 0) {
        const k = line.slice(0, idx).trim()
        if (k) out[k] = line.slice(idx + 1).trim()
      }
    }
  }
  return out
}

/** Coerce a permission's raw string value: "true"/"false" -> boolean, numeric -> number, else string. */
export function coercePermissionValue(raw: string): unknown {
  const trimmed = raw.trim()
  const lower = trimmed.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed)
  return trimmed
}

/** Set a dot-path key on a (deep-cloned) object, creating intermediate objects. */
export function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (typeof cursor[part] !== 'object' || cursor[part] === null || Array.isArray(cursor[part])) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]] = value
}

/** Read a dot-path key from an object; undefined when any segment is absent. */
export function getNestedPath(obj: Record<string, unknown> | undefined, path: string): unknown {
  let cursor: unknown = obj
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/** Each canvas item describes one SentinelOne RBAC role. */
export function extractRbacRoleSpecs(canvas: CanvasSnapshot): RbacRoleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const permissionsRaw = readKeyValueMap(fields.permissions)
    const permissions: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(permissionsRaw)) permissions[key] = coercePermissionValue(value)
    return {
      sectionName: section.name,
      name: readString(fields.name),
      description: readString(fields.description) || undefined,
      permissions,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate RBAC role configurations: a role name is required, and each name
 * (case-insensitive) must be unique across the canvas. Permission keys are not
 * validated against a fixed set (the taxonomy is tenant/SKU-specific and
 * discovered live) beyond requiring a non-blank key.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRbacRoleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required', code: 'required' })
      continue
    }

    if (Object.keys(spec.permissions).length === 0) {
      warnings.push({
        field: `${prefix}.permissions`,
        message: 'No permission overrides declared — the role will be created/kept exactly as its scope\'s template/current state',
        code: 'no_permission_overrides',
      })
    }

    const key = roleKey(spec.name)
    if (seen.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate role "${spec.name}" — each role name may only be declared once`,
        code: 'duplicate_role',
      })
    }
    seen.add(key)
  }

  return { valid: errors.length === 0, errors, warnings }
}
