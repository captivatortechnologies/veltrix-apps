import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Role constraints ------------------------------------------

export const MAX_NAME_LENGTH = 128

export interface RoleSpec {
  itemId?: string
  /** name — the logical identity (unique per tenant); the id is stored for rename-safety. */
  name: string
  description: string
  /** owning Identity id (required by ISC). */
  ownerId: string
  /** ids of access profiles this role bundles. */
  accessProfileIds: string[]
  enabled: boolean
  requestable: boolean
}

/** A role as returned by GET /v3/roles. */
export interface LiveRole {
  id?: string
  name?: string
  description?: string | null
  owner?: { id?: string }
  accessProfiles?: Array<{ id?: string }>
  enabled?: boolean
  requestable?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Read a list field authored as tags (array) or a comma/newline string, de-duped. */
function toIdList(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.map((x) => String(x).trim())
    : typeof v === 'string'
      ? v.split(/[,\n]/).map((s) => s.trim())
      : []
  return [...new Set(raw.filter((s) => s.length > 0))]
}

export function extractRoleSpecs(canvas: CanvasSnapshot): RoleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      ownerId: asString(f.ownerId),
      accessProfileIds: toIdList(f.accessProfileIds),
      enabled: asBool(f.enabled),
      requestable: asBool(f.requestable),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRoleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate role "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.ownerId) {
      errors.push({ field: `${prefix}.ownerId`, message: 'An owner Identity id is required', code: 'required' })
    }

    // A role with no access profiles grants nothing — allowed, but usually a mistake.
    if (spec.name && spec.accessProfileIds.length === 0) {
      warnings.push({ field: `${prefix}.accessProfileIds`, message: `Role "${spec.name}" bundles no access profiles — it will grant no access`, code: 'no_access_profiles' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
