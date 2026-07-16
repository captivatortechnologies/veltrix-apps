import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk integrations — manage an ALREADY-CONNECTED SCM integration's PR-test /
// auto-upgrade settings via the v1 API (GET /org/{orgId}/integrations returns a
// { type: integrationId } map, then GET/PUT /org/{orgId}/integrations/{id}/settings).
//
// This config type UPDATES an integration in place — it never creates or deletes
// one — and identity is the integration TYPE. There is no secret. It is
// DECLARATIVE: the four managed boolean keys are always sent; the numeric
// auto-dependency-upgrade limit is sent only when the user provided a value.
// =============================================================================

/** SCM integration types this config type can configure. */
export const INTEGRATION_TYPES = [
  'github',
  'github-enterprise',
  'gitlab',
  'bitbucket-cloud',
  'bitbucket-server',
  'azure-repos',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IntegrationSpec {
  sectionName: string
  integrationType: string
  prTestEnabled: boolean
  prFailOnAny: boolean
  prFailOnlyHigh: boolean
  autoDepUpgradeEnabled: boolean
  /** Optional cap on open auto-upgrade PRs — present only when the user set one. */
  autoDepUpgradeLimit?: number
}

/**
 * The v1 integration settings object. The managed keys are typed; the index
 * signature preserves any other keys Snyk returns so a merge round-trips them.
 */
export interface IntegrationSettings {
  pullRequestTestEnabled?: boolean
  pullRequestFailOnAnyVulns?: boolean
  pullRequestFailOnlyForHighSeverity?: boolean
  autoDepUpgradeEnabled?: boolean
  autoDepUpgradeLimit?: number
  [key: string]: unknown
}

/** The integration type is an integration's logical identity. */
export function integrationKey(type: string): string {
  return type.trim().toLowerCase()
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
 * Validate the optional auto-dependency-upgrade limit. Returns an error string
 * (a plain `string | null`, never a discriminated union), or null when the field
 * is absent or a valid positive integer.
 */
export function checkLimit(raw: unknown): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return null
  const n = readNumber(raw)
  if (n === undefined || !Number.isInteger(n) || n <= 0) return 'must be a positive integer'
  return null
}

/** Each canvas item describes one integration's managed settings. */
export function extractIntegrationSpecs(canvas: CanvasSnapshot): IntegrationSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      integrationType: typeof fields.integration_type === 'string' ? fields.integration_type.trim() : '',
      prTestEnabled: readBool(fields.pull_request_test_enabled, false),
      prFailOnAny: readBool(fields.pull_request_fail_on_any_vulns, false),
      prFailOnlyHigh: readBool(fields.pull_request_fail_only_high, false),
      autoDepUpgradeEnabled: readBool(fields.auto_dep_upgrade_enabled, false),
      autoDepUpgradeLimit: readNumber(fields.auto_dep_upgrade_limit),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate integration configurations: a supported integration type is required,
 * the auto-upgrade limit (when present) is a positive integer, and each
 * integration type may only be declared once.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no integration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIntegrationSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const prefix = spec.sectionName

    if (!spec.integrationType) {
      errors.push({ field: `${prefix}.integration_type`, message: 'Integration type is required', code: 'required' })
    } else if (!INTEGRATION_TYPES.includes(spec.integrationType as (typeof INTEGRATION_TYPES)[number])) {
      errors.push({
        field: `${prefix}.integration_type`,
        message: `Unsupported integration type "${spec.integrationType}"`,
        code: 'invalid_type',
      })
    }

    const limitError = checkLimit(sections[i]?.fields?.auto_dep_upgrade_limit)
    if (limitError) {
      errors.push({
        field: `${prefix}.auto_dep_upgrade_limit`,
        message: `Auto dependency-upgrade limit ${limitError}`,
        code: 'invalid_limit',
      })
    }

    if (spec.integrationType) {
      const key = integrationKey(spec.integrationType)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.integration_type`,
          message: `Duplicate integration type "${spec.integrationType}" — each type may only be declared once`,
          code: 'duplicate_integration',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
