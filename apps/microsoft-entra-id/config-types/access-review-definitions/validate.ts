import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra access-review schedule-definition constraints ---------------------
//
// The scope, reviewers and settings sub-objects are managed as validated JSON.

export const MAX_DISPLAY_NAME_LENGTH = 256

export interface AccessReviewSpec {
  itemId?: string
  /** displayName — the logical identity live definitions are matched on. */
  name: string
  descriptionForAdmins: string
  scope: string
  reviewers: string
  settings: string
}

/** An access review schedule definition as returned by Graph. */
export interface LiveAccessReview {
  id?: string
  displayName?: string
  descriptionForAdmins?: string | null
  scope?: unknown
  reviewers?: unknown
  settings?: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function parseObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

export function parseArray(text: string): unknown[] | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortValue((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

export function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v ?? null))
}

export function extractAccessReviewSpecs(canvas: CanvasSnapshot): AccessReviewSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      descriptionForAdmins: asString(f.descriptionForAdmins),
      scope: asString(f.scope),
      reviewers: asString(f.reviewers),
      settings: asString(f.settings),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAccessReviewSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) errors.push({ field: `${prefix}.name`, message: `Duplicate access review "${spec.name}"`, code: 'duplicate_name' })
      seenNames.add(key)
    }

    if (!parseObject(spec.scope)) {
      errors.push({ field: `${prefix}.scope`, message: 'Scope is required and must be a valid JSON object', code: 'invalid_scope' })
    }
    if (!parseArray(spec.reviewers)) {
      errors.push({ field: `${prefix}.reviewers`, message: 'Reviewers is required and must be a valid JSON array', code: 'invalid_reviewers' })
    }
    if (!parseObject(spec.settings)) {
      errors.push({ field: `${prefix}.settings`, message: 'Settings is required and must be a valid JSON object', code: 'invalid_settings' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
