import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC MFA Method Configuration constraints ----------------------
// Per-method singleton (keyed by `method`). configProperties is secret-bearing:
// applied on deploy but not drift-tracked. KBA is intentionally out of scope (its
// content is per-question answers, not a reconcilable config object).

export const METHODS = ['duo-web', 'okta-verify'] as const

export interface MfaConfigSpec {
  itemId?: string
  method: string
  enabled: boolean
  identityAttribute: string
  /** raw JSON for the method-specific `configProperties` object (secret-bearing). */
  configPropertiesRaw: string
}

/** An MFA method config as returned by GET /v3/mfa/{method}/config. */
export interface LiveMfaConfig {
  mfaMethod?: string
  enabled?: boolean
  identityAttribute?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function parseJsonObject(
  raw: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

export function extractMfaConfigSpecs(canvas: CanvasSnapshot): MfaConfigSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      method: asString(f.method),
      enabled: asBool(f.enabled),
      identityAttribute: asString(f.identityAttribute),
      configPropertiesRaw:
        typeof f.configProperties === 'string'
          ? f.configProperties.trim()
          : f.configProperties && typeof f.configProperties === 'object'
            ? JSON.stringify(f.configProperties)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractMfaConfigSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.method) {
      errors.push({ field: `${prefix}.method`, message: 'A method is required', code: 'required' })
    } else if (!METHODS.includes(spec.method as (typeof METHODS)[number])) {
      errors.push({ field: `${prefix}.method`, message: `Method must be one of ${METHODS.join(', ')}`, code: 'invalid_enum' })
    } else {
      if (seen.has(spec.method)) {
        errors.push({ field: `${prefix}.method`, message: `Duplicate MFA method "${spec.method}" — each may only be declared once per canvas`, code: 'duplicate_method' })
      }
      seen.add(spec.method)
    }

    const parsed = parseJsonObject(spec.configPropertiesRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.configProperties`, message: `Config properties must be a JSON object: ${parsed.error}`, code: 'invalid_config' })
    } else if (spec.enabled && !spec.configPropertiesRaw) {
      warnings.push({ field: `${prefix}.configProperties`, message: `Enabling ${spec.method} usually needs config properties (host, keys)`, code: 'empty_config' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
