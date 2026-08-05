import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Zero Trust — device posture rules ------------------------------
//
// A device posture rule is a named check (OS version, disk encryption, an EDR
// vendor's device health, ...) that WARP clients evaluate and report back.
// It lives under /accounts/{account_id}/devices/posture; Cloudflare assigns a
// server id, so identity for reconciliation is the rule `name`.
//
// Posture rules are referenced elsewhere in this app: an Access policy's
// include/require/exclude JSON can carry {"device_posture":{"integration_uid":
// "<rule-id>"}}, and a Gateway policy's rule_json can gate on
// identity.device_posture — this type manages the rules those point at.
//
// `input` is a discriminated union across ~20 check types (file/domain_joined/
// os_version/disk_encryption/a dozen vendor integrations/...), so — like
// Access applications' app_json — the raw object is taken verbatim rather than
// modeled field-by-field. `match` is a small JSON array restricting which
// client platforms the check runs on.

export const POSTURE_RULE_TYPES = [
  'file',
  'application',
  'tanium',
  'gateway',
  'warp',
  'disk_encryption',
  'serial_number',
  'sentinelone',
  'carbonblack',
  'os_version',
  'domain_joined',
  'client_certificate',
  'client_certificate_v2',
  'antivirus',
  'unique_client_id',
  'kolide',
  'tanium_s2s',
  'crowdstrike_s2s',
  'intune',
  'workspace_one',
  'sentinelone_s2s',
  'custom_s2s',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface PostureRuleSpec {
  sectionName: string
  name: string
  type: string
  description: string
  schedule: string
  expiration: string
  /** Raw JSON text for the optional platform-match array. */
  matchJson: string
  /** Raw JSON text for the required, type-specific input object. */
  inputJson: string
}

/** Shape of a posture rule returned by GET /devices/posture. */
export interface LivePostureRule {
  id?: string
  name?: string
  type?: string
  description?: string
  schedule?: string
  expiration?: string
  match?: unknown[]
  input?: Record<string, unknown>
}

/**
 * Result of parsing a JSON field. NOT a discriminated union — the platform's
 * handler loader does not narrow `{ ok:true } | { ok:false }`, so `value` and
 * `error` are always-present nullable fields.
 */
export interface JsonParseResult<T> {
  value: T | null
  error: string | null
}

export function parseJsonObject(raw: string | undefined): JsonParseResult<Record<string, unknown>> {
  const text = (raw ?? '').trim()
  if (!text) return { value: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

export function parseJsonArray(raw: string | undefined): JsonParseResult<unknown[]> {
  const text = (raw ?? '').trim()
  if (!text) return { value: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON array' }
  }
  return { value: parsed, error: null }
}

/** The reconciliation key for a posture rule — its name, case-folded. */
export function postureRuleKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item describes one Cloudflare device posture rule. */
export function extractPostureRuleSpecs(canvas: CanvasSnapshot): PostureRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      type: typeof fields.type === 'string' && fields.type.trim() ? fields.type.trim() : 'os_version',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      schedule: typeof fields.schedule === 'string' ? fields.schedule.trim() : '',
      expiration: typeof fields.expiration === 'string' ? fields.expiration.trim() : '',
      matchJson: typeof fields.match_json === 'string' ? fields.match_json : '',
      inputJson: typeof fields.input_json === 'string' ? fields.input_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate posture rule configurations: a name is required and unique across
 * the canvas (its identity), the type must be one of the supported checks,
 * input_json is required and must parse to a JSON object, and the optional
 * match_json must parse to a JSON array when present.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPostureRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    } else {
      const key = postureRuleKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule name "${spec.name}" — each posture rule must be uniquely named`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }

    if (!POSTURE_RULE_TYPES.includes(spec.type as (typeof POSTURE_RULE_TYPES)[number])) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported check type "${spec.type}"`, code: 'invalid_type' })
    }

    if (!spec.inputJson.trim()) {
      errors.push({ field: `${prefix}.input_json`, message: 'Input parameters (a JSON object) are required', code: 'required' })
    } else {
      const parsed = parseJsonObject(spec.inputJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.input_json`, message: `Input parameters ${parsed.error}`, code: 'invalid_json' })
      }
    }

    if (spec.matchJson.trim()) {
      const parsed = parseJsonArray(spec.matchJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.match_json`, message: `Match ${parsed.error}`, code: 'invalid_json' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
