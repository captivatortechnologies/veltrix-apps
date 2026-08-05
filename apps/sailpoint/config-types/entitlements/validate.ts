import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Entitlement governance-overlay constraints ----------------
// Entitlements are discovered by source aggregation, never created or deleted
// through this API — this type only overlays governance metadata (display
// name, description, requestable, privileged, owner, segments, and whether
// aggregation may overwrite the name/description) onto an entitlement that
// must already exist. Matched within a Source (resolved by name) by the
// entitlement's own name, optionally disambiguated by its schema attribute;
// the id is cached for rename-safety once first matched.

export const MAX_NAME_LENGTH = 128

export interface EntitlementSpec {
  itemId?: string
  /** name of the parent Source (resolved to an id at deploy time). */
  sourceName: string
  /** optional schema attribute (e.g. "memberOf") to disambiguate same-named entitlements on one source. */
  attribute: string
  /** the entitlement's name — matches the live entitlement and, once matched, may rename it. */
  name: string
  description: string
  /** owning Identity id — left untouched when blank. */
  ownerId: string
  requestable: boolean
  privileged: boolean
  /** ids of segments this entitlement is scoped to. */
  segments: string[]
  /** protects the declared name from being overwritten by later source aggregation. */
  lockDisplayName: boolean
  /** protects the declared description from being overwritten by later source aggregation. */
  lockDescription: boolean
}

/** An entitlement as returned by GET /beta/entitlements(/{id}). */
export interface LiveEntitlement {
  id?: string
  name?: string
  attribute?: string | null
  value?: string
  description?: string | null
  requestable?: boolean
  privileged?: boolean
  owner?: { id?: string } | null
  segments?: string[] | null
  manuallyUpdatedFields?: { DISPLAY_NAME?: boolean; DESCRIPTION?: boolean } | null
  source?: { id?: string; name?: string }
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

export function extractEntitlementSpecs(canvas: CanvasSnapshot): EntitlementSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      sourceName: asString(f.sourceName),
      attribute: asString(f.attribute),
      name: asString(f.name) || item.name,
      description: asString(f.description),
      ownerId: asString(f.ownerId),
      requestable: asBool(f.requestable),
      privileged: asBool(f.privileged),
      segments: toIdList(f.segments),
      lockDisplayName: asBool(f.lockDisplayName),
      lockDescription: asBool(f.lockDescription),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractEntitlementSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.sourceName) {
      errors.push({ field: `${prefix}.sourceName`, message: 'A parent source name is required', code: 'required' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (spec.sourceName && spec.name) {
      const key = `${spec.sourceName.toLowerCase()}::${spec.name.toLowerCase()}::${spec.attribute.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate entitlement "${spec.name}" on source "${spec.sourceName}" — each may only be declared once per canvas (add Attribute to disambiguate same-named entitlements)`, code: 'duplicate_name' })
      }
      seen.add(key)
    }

    if (spec.privileged && !spec.ownerId) {
      warnings.push({ field: `${prefix}.ownerId`, message: 'A privileged entitlement should have an accountable owner assigned', code: 'privileged_no_owner' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
