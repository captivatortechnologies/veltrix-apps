import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Access Profile constraints --------------------------------

export const MAX_NAME_LENGTH = 128

export interface AccessProfileSpec {
  itemId?: string
  /** name — the logical identity (unique per tenant); the id is stored for rename-safety. */
  name: string
  description: string
  /** owning Identity id (required by ISC). */
  ownerId: string
  /** id of the Source this access profile is attached to (required, immutable). */
  sourceId: string
  /** ids of entitlements on that source to grant. */
  entitlementIds: string[]
  enabled: boolean
  requestable: boolean
}

/** An access profile as returned by GET /v3/access-profiles. */
export interface LiveAccessProfile {
  id?: string
  name?: string
  description?: string | null
  owner?: { id?: string }
  source?: { id?: string }
  entitlements?: Array<{ id?: string }>
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

export function extractAccessProfileSpecs(canvas: CanvasSnapshot): AccessProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      ownerId: asString(f.ownerId),
      sourceId: asString(f.sourceId),
      entitlementIds: toIdList(f.entitlementIds),
      enabled: asBool(f.enabled),
      requestable: asBool(f.requestable),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAccessProfileSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate access profile "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.ownerId) {
      errors.push({ field: `${prefix}.ownerId`, message: 'An owner Identity id is required', code: 'required' })
    }
    if (!spec.sourceId) {
      errors.push({ field: `${prefix}.sourceId`, message: 'A source id is required', code: 'required' })
    }

    // ISC invariant: an enabled access profile must grant at least one entitlement.
    if (spec.enabled && spec.entitlementIds.length === 0) {
      errors.push({ field: `${prefix}.entitlementIds`, message: 'An enabled access profile must include at least one entitlement id', code: 'entitlements_required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
