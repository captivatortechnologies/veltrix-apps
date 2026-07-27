import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Tenant Configuration Singletons ---------------------------
// Groups the fixed, tenant-wide reference singletons. Each is read+replaced (no
// create/delete): the app snapshots the prior value, applies the desired scalars,
// and reverts to the snapshot on rollback or when a setting is no longer declared.
// SETTINGS must stay in sync with the REGISTRY in deploy.ts.

export const SETTINGS = [
  'access-request-config',
  'password-org-config',
  'public-identities-config',
  'org-config',
  'auth-org-lockout',
  'auth-org-session',
  'auth-org-network',
  'auth-org-service-provider',
] as const

export interface TenantConfigSpec {
  itemId?: string
  /** which tenant singleton this item configures. */
  setting: string
  /** raw JSON for the desired top-level scalar values. */
  configRaw: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
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

export function extractTenantConfigSpecs(canvas: CanvasSnapshot): TenantConfigSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      setting: asString(f.setting),
      configRaw:
        typeof f.config === 'string'
          ? f.config.trim()
          : f.config && typeof f.config === 'object'
            ? JSON.stringify(f.config)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTenantConfigSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.setting) {
      errors.push({ field: `${prefix}.setting`, message: 'A setting is required', code: 'required' })
    } else if (!SETTINGS.includes(spec.setting as (typeof SETTINGS)[number])) {
      errors.push({ field: `${prefix}.setting`, message: `Setting must be one of ${SETTINGS.join(', ')}`, code: 'invalid_enum' })
    } else {
      if (seen.has(spec.setting)) {
        errors.push({ field: `${prefix}.setting`, message: `Duplicate setting "${spec.setting}" — each singleton may only be declared once per canvas`, code: 'duplicate_setting' })
      }
      seen.add(spec.setting)
    }

    const parsed = parseJsonObject(spec.configRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.config`, message: `Config must be a JSON object: ${parsed.error}`, code: 'invalid_config' })
    } else if (spec.setting && !spec.configRaw) {
      errors.push({ field: `${prefix}.config`, message: 'A config object with the desired values is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
