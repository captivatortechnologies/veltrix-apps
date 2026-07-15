import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Access — applications -----------------------------------------
//
// Account-scoped Access application objects (/accounts/{a}/access/apps). Each
// canvas item is one Access application, keyed by its `name` (the reconciliation
// identity — Cloudflare assigns a server id, so re-runs match on name and update
// rather than duplicate).

export const APP_TYPES = ['self_hosted', 'saas', 'ssh', 'vnc', 'bookmark'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AccessAppSpec {
  sectionName: string
  name: string
  domain: string
  type: string
  sessionDuration: string
  /** Optional advanced-fields JSON object, merged into the request body. */
  appJson: string
}

/** Shape of an Access application returned by GET /access/apps. */
export interface LiveAccessApp {
  id?: string
  name?: string
  domain?: string
  type?: string
  session_duration?: string
  [key: string]: unknown
}

/**
 * Result of parsing app_json. NOT a discriminated union — the platform's handler
 * loader does not narrow `{ ok:true } | { ok:false }`, so `value` and `error` are
 * always-present nullable fields.
 */
export interface JsonParseResult {
  value: Record<string, unknown> | null
  error: string | null
}

export function parseJsonObject(raw: string | undefined): JsonParseResult {
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

/** The reconciliation key for an Access application — its name, case-folded. */
export function accessAppKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item describes one Cloudflare Access application. */
export function extractAccessAppSpecs(canvas: CanvasSnapshot): AccessAppSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const type = typeof fields.type === 'string' && fields.type.trim() ? fields.type.trim() : 'self_hosted'
    const sessionDuration =
      typeof fields.session_duration === 'string' && fields.session_duration.trim()
        ? fields.session_duration.trim()
        : '24h'
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      domain: typeof fields.domain === 'string' ? fields.domain.trim() : '',
      type,
      sessionDuration,
      appJson: typeof fields.app_json === 'string' ? fields.app_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Access application configurations: a name and domain are required,
 * the name must be unique across the canvas (it is the reconciliation identity),
 * and app_json (when present) must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAccessAppSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Application name is required', code: 'required' })
    } else {
      const key = accessAppKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate application name "${spec.name}" — each Access application must be uniquely named`,
          code: 'duplicate_app',
        })
      }
      seen.add(key)
    }

    if (!spec.domain) {
      errors.push({ field: `${prefix}.domain`, message: 'Application domain is required', code: 'required' })
    }

    if (spec.appJson.trim()) {
      const parsed = parseJsonObject(spec.appJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.app_json`, message: `Advanced fields ${parsed.error}`, code: 'invalid_json' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
