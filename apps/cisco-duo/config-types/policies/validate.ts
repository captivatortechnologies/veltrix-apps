import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cisco Duo policy constraints --------------------------------------------

export const MAX_NAME_LENGTH = 255

export interface PolicySpec {
  itemId?: string
  /** policy_name — the logical identity (Duo policies are addressed by an opaque
   *  policy_key, so the app matches on name and stores the key for rename-safety). */
  name: string
  /** Whether this item is the tenant's Global Policy — an update-only singleton
   *  that is never created or deleted. */
  isGlobal: boolean
  /** Raw `sections` JSON text from the canvas (an opaque, round-tripped blob). */
  sectionsRaw: string
}

/** A policy as returned by GET /admin/v2/policies[/{policy_key}]. */
export interface LivePolicy {
  policy_key?: string
  policy_name?: string
  sections?: Record<string, unknown> | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true
}

export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      isGlobal: asBool(f.is_global),
      sectionsRaw: typeof f.sections === 'string' ? f.sections : '',
    }
  })
}

export interface ParsedSections {
  ok: boolean
  value?: Record<string, unknown>
  error?: string
}

/**
 * Parse the `sections` blob. Empty text means "manage no sections" ({}). A valid
 * blob must be a JSON OBJECT whose values are themselves objects (each section
 * name maps to that section's settings). The inner settings are treated as an
 * opaque, round-tripped payload — their deep schema is not modeled here.
 */
export function parseSections(raw: string): ParsedSections {
  const text = raw.trim()
  if (!text) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'sections must be a JSON object keyed by section name' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** Section names whose values are not objects — a structural problem to warn on. */
export function nonObjectSectionKeys(sections: Record<string, unknown>): string[] {
  return Object.keys(sections).filter((k) => {
    const v = sections[k]
    return v === null || typeof v !== 'object' || Array.isArray(v)
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()
  let globalCount = 0

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
        errors.push({ field: `${prefix}.name`, message: `Duplicate policy "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.isGlobal) globalCount++

    const parsed = parseSections(spec.sectionsRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.sections`, message: `Invalid sections: ${parsed.error}`, code: 'invalid_json' })
    } else if (parsed.value) {
      const bad = nonObjectSectionKeys(parsed.value)
      if (bad.length) {
        errors.push({
          field: `${prefix}.sections`,
          message: `Each section must map to a settings object; not an object: ${bad.join(', ')}`,
          code: 'section_not_object',
        })
      }
      if (spec.isGlobal && Object.keys(parsed.value).length === 0) {
        warnings.push({
          field: `${prefix}.sections`,
          message: 'Global Policy declared with no sections — deploy will leave its settings unchanged',
          code: 'empty_global',
        })
      }
    }
  })

  if (globalCount > 1) {
    errors.push({ field: 'items', message: 'Only one policy may be marked as the Global Policy', code: 'duplicate_global' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
