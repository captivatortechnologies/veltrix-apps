import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk project ignores — ignore a specific issue in a specific project via the
// v1 API (GET/POST/PUT/DELETE /org/{orgId}/project/{projectId}/ignore/{issueId}).
//
// Identity is the (project id, issue id) pair. The deploy uses PUT ("Replace
// ignores"), so the declared rule REPLACES that issue's ignores — a declarative,
// idempotent upsert. There is no secret. reasonType is one of Snyk's fixed
// classifications; a temporary-ignore additionally requires an `expires` date.
// =============================================================================

export const REASON_TYPES = ['not-vulnerable', 'wont-fix', 'temporary-ignore'] as const
export type ReasonType = (typeof REASON_TYPES)[number]

export interface IgnoreSpec {
  sectionName: string
  projectId: string
  issueId: string
  reasonType: string
  reason: string
  ignorePath: string
  disregardIfFixable: boolean
  /** ISO timestamp — present only when the user set one. */
  expires?: string
}

/**
 * A v1 ignore rule as sent on PUT/POST. `expires` is only included for a
 * temporary ignore. This mirrors the Snyk `Ignorerule` schema.
 */
export interface IgnoreRule {
  ignorePath: string
  reason?: string
  reasonType: string
  disregardIfFixable: boolean
  expires?: string
}

/** The (project id, issue id) pair is an ignore's logical identity. */
export function ignoreKey(projectId: string, issueId: string): string {
  return `${projectId.trim().toLowerCase()}::${issueId.trim().toLowerCase()}`
}

/** Read a checkbox/boolean-ish field, falling back to `fallback` when unset. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'true' || t === 'yes' || t === '1') return true
    if (t === 'false' || t === 'no' || t === '0' || t === '') return false
  }
  return fallback
}

/** True when a string parses as a date (used to validate `expires`). */
export function isValidDate(raw: string): boolean {
  return !Number.isNaN(Date.parse(raw))
}

/** Each canvas item describes one issue ignore. */
export function extractIgnoreSpecs(canvas: CanvasSnapshot): IgnoreSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const path = typeof fields.ignore_path === 'string' && fields.ignore_path.trim() ? fields.ignore_path.trim() : '*'
    const expires = typeof fields.expires === 'string' && fields.expires.trim() ? fields.expires.trim() : undefined
    return {
      sectionName: section.name,
      projectId: typeof fields.project_id === 'string' ? fields.project_id.trim() : '',
      issueId: typeof fields.issue_id === 'string' ? fields.issue_id.trim() : '',
      reasonType:
        typeof fields.reason_type === 'string' && fields.reason_type.trim() ? fields.reason_type.trim() : 'not-vulnerable',
      reason: typeof fields.reason === 'string' ? fields.reason.trim() : '',
      ignorePath: path,
      disregardIfFixable: readBool(fields.disregard_if_fixable, false),
      expires,
    }
  })
}

/** Build the v1 ignore-rule body for a spec. `expires` is only sent when present. */
export function toIgnoreRule(spec: IgnoreSpec): IgnoreRule {
  return {
    ignorePath: spec.ignorePath || '*',
    ...(spec.reason ? { reason: spec.reason } : {}),
    reasonType: spec.reasonType,
    disregardIfFixable: spec.disregardIfFixable,
    ...(spec.expires ? { expires: spec.expires } : {}),
  }
}

/**
 * Validate ignore configurations: a project id, issue id and supported reason
 * type are required; a temporary ignore requires a valid `expires` date (and any
 * provided `expires` must parse); and each (project id, issue id) pair is unique.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no ignore items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIgnoreSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.projectId) {
      errors.push({ field: `${prefix}.project_id`, message: 'Project ID is required', code: 'required' })
    }
    if (!spec.issueId) {
      errors.push({ field: `${prefix}.issue_id`, message: 'Issue ID is required', code: 'required' })
    }
    if (!REASON_TYPES.includes(spec.reasonType as ReasonType)) {
      errors.push({
        field: `${prefix}.reason_type`,
        message: `Unsupported reason type "${spec.reasonType}" — must be one of: ${REASON_TYPES.join(', ')}`,
        code: 'invalid_reason_type',
      })
    }

    if (spec.reasonType === 'temporary-ignore' && !spec.expires) {
      errors.push({
        field: `${prefix}.expires`,
        message: 'A temporary ignore requires an expiry date',
        code: 'expires_required',
      })
    }
    if (spec.expires && !isValidDate(spec.expires)) {
      errors.push({
        field: `${prefix}.expires`,
        message: `Expiry "${spec.expires}" is not a valid ISO 8601 timestamp`,
        code: 'invalid_expires',
      })
    }

    if (spec.projectId && spec.issueId) {
      const key = ignoreKey(spec.projectId, spec.issueId)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.issue_id`,
          message: `Duplicate ignore for issue "${spec.issueId}" in project "${spec.projectId}" — each pair may only be declared once`,
          code: 'duplicate_ignore',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
