import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk service accounts — automation identities bound to a Snyk org role,
// managed through the REST (JSON:API) API
// (GET/POST/PATCH/DELETE /orgs/{org_id}/service_accounts). Identity is the
// account name (natural key). Snyk generates the account's API token / client
// secret ONCE on create and returns it in the create response attributes — it is
// WRITE-ONLY: never read back, never diffed, never stored in rollback data,
// artifacts, messages or logs. auth_type is immutable after creation.
// =============================================================================

export const AUTH_TYPES = ['api_key', 'oauth_client_secret', 'oauth_private_key_jwt'] as const

export interface ServiceAccountSpec {
  sectionName: string
  name: string
  roleId: string
  authType: string
  accessTokenTtlSeconds?: number
}

/**
 * A service account as returned by GET /orgs/{org_id}/service_accounts. This is
 * a JSON:API resource object, so the descriptive fields are NESTED under
 * `attributes`. The generated token/secret is never read from here.
 */
export interface LiveServiceAccount {
  id?: string
  attributes?: {
    name?: string
    auth_type?: string
    role_id?: string
  }
}

/** The account name is a service account's logical identity. */
export function saKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Parse an optional positive-integer field (the access-token TTL). NON-UNION
 * { value, error } — never a discriminated union, which the platform handler
 * loader cannot narrow. Absent/blank → { value: null, error: null }; present but
 * not a positive integer → an error string.
 */
export interface NumberParseResult {
  value: number | null
  error: string | null
}

export function parsePositiveInt(raw: unknown): NumberParseResult {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { value: null, error: null }
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { value: null, error: 'must be a positive integer' }
  }
  return { value: n, error: null }
}

/** Each canvas item describes one Snyk service account. */
export function extractServiceAccountSpecs(canvas: CanvasSnapshot): ServiceAccountSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const ttl = parsePositiveInt(fields.access_token_ttl_seconds).value
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      roleId: typeof fields.role_id === 'string' ? fields.role_id.trim() : '',
      authType:
        typeof fields.auth_type === 'string' && fields.auth_type.trim() ? fields.auth_type.trim() : 'api_key',
      accessTokenTtlSeconds: ttl ?? undefined,
    }
  })
}

/**
 * Validate service-account configurations: a name and org role id are required,
 * the auth type is from the supported set, an access-token TTL (when present) is
 * a positive integer, and each account name is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no service account items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractServiceAccountSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index]
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Service account name is required', code: 'required' })
    }
    if (!spec.roleId) {
      errors.push({ field: `${prefix}.role_id`, message: 'A Snyk org role id is required', code: 'required' })
    }
    if (!AUTH_TYPES.includes(spec.authType as (typeof AUTH_TYPES)[number])) {
      errors.push({
        field: `${prefix}.auth_type`,
        message: `Unsupported auth type "${spec.authType}"`,
        code: 'invalid_auth_type',
      })
    }

    const ttl = parsePositiveInt(sections[index]?.fields?.access_token_ttl_seconds)
    if (ttl.error) {
      errors.push({
        field: `${prefix}.access_token_ttl_seconds`,
        message: `Access token TTL ${ttl.error}`,
        code: 'invalid_ttl',
      })
    }

    if (spec.name) {
      const key = saKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate service account "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_account',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
