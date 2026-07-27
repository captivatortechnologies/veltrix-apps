import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra permission-grant-policy constraints -------------------------------

export const MAX_DISPLAY_NAME_LENGTH = 256
/** Client-supplied id: lowercase letters, digits and hyphens. */
const POLICY_ID_RE = /^[a-z0-9][a-z0-9-]*$/
/** Built-in policies are reserved and must never be managed by this app. */
export const RESERVED_ID_PREFIX = 'microsoft-'

export interface PermissionGrantPolicySpec {
  itemId?: string
  /** Client-supplied policy id (kebab) — the logical identity and Graph id. */
  id: string
  displayName: string
  description: string
  /** Raw JSON text: an array of permissionGrantConditionSet objects. */
  includes: string
  excludes: string
}

/** A permission grant policy as returned by Graph (metadata only). */
export interface LivePermissionGrantPolicy {
  id?: string
  displayName?: string
  description?: string | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse a JSON string into an array, or null when it isn't a JSON array. */
export function parseArray(text: string): Array<Record<string, unknown>> | null {
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return null
    return parsed as Array<Record<string, unknown>>
  } catch {
    return null
  }
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

/** Drop server-assigned metadata (id, @odata.*) so two condition sets compare on content. */
export function stripConditionSet(cs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cs)) {
    if (k === 'id' || k.startsWith('@odata')) continue
    out[k] = v
  }
  return out
}

/** Order-insensitive canonical form of a list of condition sets. */
export function canonicalSetList(sets: Array<Record<string, unknown>>): string {
  const items = sets.map((s) => JSON.stringify(sortValue(stripConditionSet(s))))
  items.sort()
  return JSON.stringify(items)
}

export function extractPermissionGrantPolicySpecs(canvas: CanvasSnapshot): PermissionGrantPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      id: asString(f.id).toLowerCase(),
      displayName: asString(f.displayName) || item.name,
      description: asString(f.description),
      includes: asString(f.includes),
      excludes: asString(f.excludes),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPermissionGrantPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'Policy id is required', code: 'required' })
    } else {
      if (!POLICY_ID_RE.test(spec.id)) {
        errors.push({
          field: `${prefix}.id`,
          message: 'Policy id must be lowercase letters, digits and hyphens',
          code: 'invalid_id',
        })
      }
      if (spec.id.startsWith(RESERVED_ID_PREFIX)) {
        errors.push({
          field: `${prefix}.id`,
          message: `Policy id must not start with "${RESERVED_ID_PREFIX}" — those are reserved built-in policies`,
          code: 'reserved_id',
        })
      }
      if (seen.has(spec.id)) {
        errors.push({
          field: `${prefix}.id`,
          message: `Duplicate policy id "${spec.id}" — each may only be declared once per canvas`,
          code: 'duplicate_id',
        })
      }
      seen.add(spec.id)
    }

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Display name is required', code: 'required' })
    } else if (spec.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.displayName`,
        message: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
        code: 'too_long',
      })
    }

    for (const field of ['includes', 'excludes'] as const) {
      if (spec[field] && !parseArray(spec[field])) {
        errors.push({
          field: `${prefix}.${field}`,
          message: `${field} must be a valid JSON array of condition sets`,
          code: 'invalid_json',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
