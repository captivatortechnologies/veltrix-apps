import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Zero Trust Access — identity providers -------------------------
//
// An identity provider (IdP) backs the login experience for Access applications
// (an app's advanced `allowed_idps` field references an IdP by id) and Access
// policies' `login_method` rule. It lives under
// /accounts/{account_id}/access/identity_providers; Cloudflare assigns a server
// id, so identity for reconciliation is the IdP `name` (Cloudflare does not
// enforce name uniqueness, but this app — like every other Access/Gateway type
// — treats it as the logical identity for matching).
//
// `config` is entirely provider-specific across the 15 supported types (OAuth
// providers need client_id/client_secret/auth_url/..., SAML needs issuer_url/
// sso endpoints/certs, One-Time PIN needs nothing). Rather than model 15
// different shapes, `config_json` takes the raw object verbatim — the same
// "advanced JSON" convention app_json / rule_json use elsewhere in this app.
//
// ⚠ SECURITY: an OAuth/OIDC/SAML config's secret-bearing fields (e.g.
// `client_secret`) are write-only (Cloudflare marks them `x-sensitive`) — GET
// never echoes them back. Drift therefore reports presence + name/type only,
// never a value-level diff of config_json — the same treatment
// cloudflare-access-groups gives its rule arrays, for the same reason: a field
// Cloudflare redacts cannot be diffed without a false positive on every check.

export const IDENTITY_PROVIDER_TYPES = [
  'onetimepin',
  'cloudflare',
  'azureAD',
  'okta',
  'oidc',
  'saml',
  'google',
  'google-apps',
  'github',
  'facebook',
  'linkedin',
  'onelogin',
  'pingone',
  'centrify',
  'yandex',
] as const

/** Provider types that need no `config` at all — Cloudflare-hosted, no external IdP. */
export const NO_CONFIG_TYPES = new Set(['onetimepin', 'cloudflare'])

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IdentityProviderSpec {
  sectionName: string
  name: string
  type: string
  /** Raw JSON text for the provider-specific `config` object. */
  configJson: string
  /** Optional JSON object merged onto the body at the top level (currently: scim_config). */
  advancedJson: string
}

/** Shape of an identity provider returned by GET /access/identity_providers. */
export interface LiveIdentityProvider {
  id?: string
  name?: string
  type?: string
  config?: Record<string, unknown>
  scim_config?: Record<string, unknown>
  /** True when Cloudflare manages this IdP and rejects API writes to it. */
  read_only?: boolean
}

/**
 * Result of parsing a JSON-object field. NOT a discriminated union — the
 * platform's handler loader does not narrow `{ ok:true } | { ok:false }`, so
 * `value` and `error` are always-present nullable fields.
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

/** The reconciliation key for an identity provider — its name, case-folded. */
export function idpKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item describes one Cloudflare Access identity provider. */
export function extractIdentityProviderSpecs(canvas: CanvasSnapshot): IdentityProviderSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      type: typeof fields.type === 'string' && fields.type.trim() ? fields.type.trim() : 'onetimepin',
      configJson: typeof fields.config_json === 'string' ? fields.config_json : '',
      advancedJson: typeof fields.advanced_json === 'string' ? fields.advanced_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate identity provider configurations: a name is required and unique
 * across the canvas (its identity), the type must be one of the 15 supported
 * providers, config_json is required (and must parse to a JSON object) for
 * every type except One-Time PIN / Cloudflare (built-in), and the optional
 * advanced_json must parse to a JSON object when present.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIdentityProviderSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Identity provider name is required', code: 'required' })
    } else {
      const key = idpKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate identity provider name "${spec.name}" — each must be uniquely named`,
          code: 'duplicate_idp',
        })
      }
      seen.add(key)
    }

    if (!IDENTITY_PROVIDER_TYPES.includes(spec.type as (typeof IDENTITY_PROVIDER_TYPES)[number])) {
      errors.push({
        field: `${prefix}.type`,
        message: `Unsupported identity provider type "${spec.type}"`,
        code: 'invalid_type',
      })
    }

    if (spec.configJson.trim()) {
      const parsed = parseJsonObject(spec.configJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.config_json`, message: `Provider config ${parsed.error}`, code: 'invalid_json' })
      }
    } else if (!NO_CONFIG_TYPES.has(spec.type)) {
      errors.push({
        field: `${prefix}.config_json`,
        message: `Provider config is required for type "${spec.type}"`,
        code: 'required',
      })
    }

    if (spec.advancedJson.trim()) {
      const parsed = parseJsonObject(spec.advancedJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.advanced_json`, message: `Advanced fields ${parsed.error}`, code: 'invalid_json' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
