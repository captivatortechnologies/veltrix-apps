import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk Secrets (secrets-in-code detection) settings — a SINGLETON org setting.
//
// GET/PATCH /orgs/{org_id}/settings/secrets, attribute { secrets_enabled }. Same
// shape as SAST settings (config-types/snyk-sast-settings) but the operation is
// tagged `x-snyk-api-stability: beta` / `2024-10-15~beta` in Snyk's OpenAPI spec
// ("Early Access") — the response/request shape may still change. The canvas
// carries exactly one (non-repeatable) item.
// =============================================================================

export interface SecretsSettingsSpec {
  sectionName: string
  secretsEnabled: boolean
}

/** The JSON:API attributes of the Secrets settings object. */
export interface LiveSecretsSettings {
  secrets_enabled?: boolean
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

/** A Secrets settings canvas holds a single item. Extract it (or a disabled default). */
export function extractSecretsSettings(canvas: CanvasSnapshot): SecretsSettingsSpec {
  const section = (canvas.sections ?? [])[0]
  const fields = section?.fields ?? {}
  return {
    sectionName: section?.name ?? 'Secrets Settings',
    secretsEnabled: readBool(fields.secrets_enabled, false),
  }
}

/**
 * Validate Secrets settings: exactly one item is expected (it is a singleton
 * org setting). Warns when Secrets scanning is being turned off.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no Secrets settings item', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({
      field: 'sections',
      message: 'Secrets settings is a single org-wide setting — declare only one item',
      code: 'singleton_only',
    })
  }

  const spec = extractSecretsSettings(ctx.canvas)
  if (!spec.secretsEnabled) {
    warnings.push({
      field: `${spec.sectionName}.secrets_enabled`,
      message: 'Snyk Secrets scanning will be DISABLED for this organization — no secrets-in-code scans will run',
      code: 'secrets_disabled',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
