import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps data access scope constraints -----------------------------

/** dataAccessScopeId: starts with a letter, letters/digits/underscore/hyphen, max 63 (AIP-122). */
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/

export interface DataAccessScopeSpec {
  itemId?: string
  /** name = dataAccessScopeId — the immutable identity. */
  name: string
  description: string
  /** Grant access to all data (except denied labels). Mutually exclusive with allowedLabels; fixed at creation. */
  allowAll: boolean
  /** Data access label IDs the scope allows (OR-ed). */
  allowedLabels: string[]
  /** Data access label IDs the scope denies (AND-ed). */
  deniedLabels: string[]
}

/** A DataAccessLabelReference — its identity is one of these keys. This app writes the dataAccessLabel form. */
export interface LiveLabelReference {
  dataAccessLabel?: string
  logType?: string
  assetNamespace?: string
  ingestionLabel?: { ingestionLabelKey?: string; ingestionLabelValue?: string }
  displayName?: string
}

/** A data access scope as returned by the SecOps API. `name` is `{parent}/dataAccessScopes/{id}`. */
export interface LiveDataAccessScope {
  name?: string
  displayName?: string
  description?: string
  allowAll?: boolean
  allowedDataAccessLabels?: LiveLabelReference[]
  deniedDataAccessLabels?: LiveLabelReference[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true
}

/** Parse a textarea — one label id per line — into a de-duplicated list. */
export function parseLabels(v: unknown): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of asString(v).split(/\n/)) {
    const id = line.trim()
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

export function extractDataAccessScopeSpecs(canvas: CanvasSnapshot): DataAccessScopeSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      allowAll: asBool(f.allowAll),
      allowedLabels: parseLabels(f.allowedLabels),
      deniedLabels: parseLabels(f.deniedLabels),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDataAccessScopeSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (!ID_RE.test(spec.name)) {
        errors.push({ field: `${prefix}.name`, message: 'Name must start with a letter, contain only letters, digits, underscores and hyphens, and be at most 63 characters', code: 'invalid_name' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate data access scope "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    // allow_all and allowedLabels are mutually exclusive, and exactly one must be present.
    if (spec.allowAll && spec.allowedLabels.length > 0) {
      errors.push({ field: `${prefix}.allowAll`, message: '"Allow all" and allowed labels are mutually exclusive — set one or the other', code: 'allow_all_conflict' })
    }
    if (!spec.allowAll && spec.allowedLabels.length === 0) {
      errors.push({ field: `${prefix}.allowedLabels`, message: 'Provide at least one allowed label, or enable "Allow all"', code: 'no_allow' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
