import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra admin-consent-request-policy constraints --------------------------

export interface AdminConsentRequestSpec {
  itemId?: string
  isEnabled: boolean
  notifyReviewers: boolean
  remindersEnabled: boolean
  requestDurationInDays: number
  /** Raw JSON text for the reviewers array (accessReviewReviewerScope[]). */
  reviewers: string
}

/** The admin consent request policy singleton as returned by Graph. */
export interface LiveAdminConsentRequestPolicy {
  isEnabled?: boolean
  notifyReviewers?: boolean
  remindersEnabled?: boolean
  requestDurationInDays?: number
  reviewers?: unknown[]
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return fallback
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse a JSON string into an array, or null when it isn't a JSON array. */
export function parseArray(text: string): unknown[] | null {
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Recursively sort object keys so equal values stringify identically. */
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

export function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v ?? []))
}

export function extractAdminConsentRequestSpecs(canvas: CanvasSnapshot): AdminConsentRequestSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      isEnabled: asBool(f.isEnabled),
      notifyReviewers: asBool(f.notifyReviewers),
      remindersEnabled: asBool(f.remindersEnabled),
      requestDurationInDays: asNumber(f.requestDurationInDays, 30),
      reviewers: asString(f.reviewers),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAdminConsentRequestSpecs(ctx.canvas)

  if (specs.length > 1) {
    errors.push({
      field: 'items',
      message: 'The admin consent request policy is a singleton — declare it only once per canvas',
      code: 'singleton',
    })
  }

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!Number.isInteger(spec.requestDurationInDays) || spec.requestDurationInDays <= 0) {
      errors.push({
        field: `${prefix}.requestDurationInDays`,
        message: 'Request duration must be a positive whole number of days',
        code: 'invalid_duration',
      })
    }

    const reviewers = parseArray(spec.reviewers)
    if (reviewers === null) {
      errors.push({
        field: `${prefix}.reviewers`,
        message: 'Reviewers must be a valid JSON array of reviewer scopes',
        code: 'invalid_json',
      })
    } else if (spec.isEnabled && reviewers.length === 0) {
      warnings.push({
        field: `${prefix}.reviewers`,
        message: 'Admin consent requests are enabled but no reviewers are configured — requests will have no one to review them',
        code: 'no_reviewers',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
