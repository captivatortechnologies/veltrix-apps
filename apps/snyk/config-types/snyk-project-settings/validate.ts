import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk project settings — manage an EXISTING project's PR-test / auto-upgrade
// settings via the v1 API
// (GET/PUT/DELETE /org/{orgId}/project/{projectId}/settings).
//
// This config type UPDATES a project in place — it never creates or deletes one
// — and identity is the project id. There is no secret. It is DECLARATIVE: the
// three managed boolean keys are always sent; the two numeric limits are sent
// only when the user provided a value.
// =============================================================================

export interface ProjectSettingsSpec {
  sectionName: string
  projectId: string
  prTestEnabled: boolean
  prFailOnAny: boolean
  prFailOnlyHigh: boolean
  autoDepUpgradeEnabled: boolean
  /** Optional cap on open auto-upgrade PRs — present only when the user set one. */
  autoDepUpgradeLimit?: number
  /** Optional minimum dependency age in days — present only when the user set one. */
  autoDepUpgradeMinAge?: number
}

/**
 * The v1 project-settings object. The managed keys are typed; the index
 * signature preserves any other keys Snyk returns (pullRequestAssignment,
 * autoRemediationPrs, …) so rollback can restore them untouched.
 */
export interface ProjectSettings {
  pullRequestTestEnabled?: boolean
  pullRequestFailOnAnyVulns?: boolean
  pullRequestFailOnlyForHighSeverity?: boolean
  autoDepUpgradeEnabled?: boolean
  autoDepUpgradeLimit?: number
  autoDepUpgradeMinAge?: number
  [key: string]: unknown
}

/** The project id is a project's logical identity. */
export function projectKey(projectId: string): string {
  return projectId.trim().toLowerCase()
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

/** Read an optional numeric field; undefined when blank or non-numeric. */
export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/**
 * Validate an optional whole-number field. Returns an error string (a plain
 * `string | null`, never a discriminated union), or null when the field is
 * absent or a valid integer at or above `min`.
 */
export function checkInteger(raw: unknown, min: number): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return null
  const n = readNumber(raw)
  if (n === undefined || !Number.isInteger(n) || n < min) {
    return min > 0 ? 'must be a positive integer' : 'must be a whole number (zero or greater)'
  }
  return null
}

/** Each canvas item describes one project's managed settings. */
export function extractProjectSettingsSpecs(canvas: CanvasSnapshot): ProjectSettingsSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      projectId: typeof fields.project_id === 'string' ? fields.project_id.trim() : '',
      prTestEnabled: readBool(fields.pull_request_test_enabled, false),
      prFailOnAny: readBool(fields.pull_request_fail_on_any_vulns, false),
      prFailOnlyHigh: readBool(fields.pull_request_fail_only_high, false),
      autoDepUpgradeEnabled: readBool(fields.auto_dep_upgrade_enabled, false),
      autoDepUpgradeLimit: readNumber(fields.auto_dep_upgrade_limit),
      autoDepUpgradeMinAge: readNumber(fields.auto_dep_upgrade_min_age),
    }
  })
}

/**
 * Validate project-settings configurations: a project id is required, the
 * numeric limits (when present) are whole numbers, and each project id may only
 * be declared once.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no project items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractProjectSettingsSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const prefix = spec.sectionName

    if (!spec.projectId) {
      errors.push({ field: `${prefix}.project_id`, message: 'Project ID is required', code: 'required' })
    }

    const limitError = checkInteger(sections[i]?.fields?.auto_dep_upgrade_limit, 1)
    if (limitError) {
      errors.push({
        field: `${prefix}.auto_dep_upgrade_limit`,
        message: `Max open upgrade PRs ${limitError}`,
        code: 'invalid_limit',
      })
    }

    const ageError = checkInteger(sections[i]?.fields?.auto_dep_upgrade_min_age, 0)
    if (ageError) {
      errors.push({
        field: `${prefix}.auto_dep_upgrade_min_age`,
        message: `Minimum dependency age ${ageError}`,
        code: 'invalid_min_age',
      })
    }

    if (spec.projectId) {
      const key = projectKey(spec.projectId)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.project_id`,
          message: `Duplicate project "${spec.projectId}" — each project may only be declared once`,
          code: 'duplicate_project',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
