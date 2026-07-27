import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud anomaly trusted list constraints ---------------------------

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 2000

export const TRUSTED_LIST_TYPES = ['ip', 'resource', 'image', 'tag', 'service', 'port', 'subject', 'domain', 'protocol']

export interface AnomalyTrustedListSpec {
  itemId?: string
  /** name — the identity (Prisma matches anomaly trusted lists by name). */
  name: string
  description: string
  trustedListType: string
  accountId: string
  vpc: string
  /** anomaly policy ids this trusted list applies to. */
  applicablePolicies: string[]
  /** trustedListEntries — a JSON array whose element shape depends on the type. */
  trustedListEntries: unknown[]
  /** set when the raw entries value could not be parsed as a JSON array. */
  entriesError?: string
}

/** An anomaly trusted list as returned by GET /anomalies/trusted_list. */
export interface LiveAnomalyTrustedList {
  id?: string
  name?: string
  description?: string | null
  trustedListType?: string
  accountId?: string
  vpc?: string
  applicablePolicies?: string[]
  trustedListEntries?: unknown[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function splitIds(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function parseEntries(v: unknown): { entries: unknown[]; entriesError?: string } {
  if (Array.isArray(v)) return { entries: v }
  if (v === null || v === undefined) return { entries: [] }
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return { entries: [] }
    try {
      const parsed = JSON.parse(t)
      if (Array.isArray(parsed)) return { entries: parsed }
      return { entries: [], entriesError: 'Entries must be a JSON array' }
    } catch {
      return { entries: [], entriesError: 'Entries must be valid JSON' }
    }
  }
  return { entries: [], entriesError: 'Entries must be a JSON array' }
}

export function extractAnomalyTrustedListSpecs(canvas: CanvasSnapshot): AnomalyTrustedListSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const { entries, entriesError } = parseEntries(f.trustedListEntries)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      trustedListType: asString(f.trustedListType),
      accountId: asString(f.accountId) || 'any',
      vpc: asString(f.vpc) || 'any',
      applicablePolicies: splitIds(f.applicablePolicies),
      trustedListEntries: entries,
      entriesError,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAnomalyTrustedListSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate anomaly trusted list "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (!spec.trustedListType) {
      errors.push({ field: `${prefix}.trustedListType`, message: 'Trusted list type is required', code: 'required' })
    } else if (!TRUSTED_LIST_TYPES.includes(spec.trustedListType)) {
      errors.push({ field: `${prefix}.trustedListType`, message: `Trusted list type must be one of: ${TRUSTED_LIST_TYPES.join(', ')}`, code: 'invalid_type' })
    }

    if (spec.applicablePolicies.length === 0) {
      errors.push({ field: `${prefix}.applicablePolicies`, message: 'At least one applicable anomaly policy id is required', code: 'required' })
    }

    if (spec.entriesError) {
      errors.push({ field: `${prefix}.trustedListEntries`, message: spec.entriesError, code: 'invalid_entries' })
    } else if (spec.trustedListEntries.length === 0) {
      errors.push({ field: `${prefix}.trustedListEntries`, message: 'At least one trusted list entry is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
