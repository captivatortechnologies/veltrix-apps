import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra oauth2PermissionGrant (delegated consent) constraints -------------

export const CONSENT_TYPES = new Set(['AllPrincipals', 'Principal'])

export interface OAuth2GrantSpec {
  itemId?: string
  clientId: string
  resourceId: string
  consentType: string
  principalId: string
  scope: string
}

/** An oauth2PermissionGrant as returned by Graph. */
export interface LiveOAuth2Grant {
  id?: string
  clientId?: string
  resourceId?: string
  consentType?: string
  principalId?: string | null
  scope?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Composite natural key for a grant (client + resource + consent [+ principal]). */
export function grantKey(g: {
  clientId?: string | null
  resourceId?: string | null
  consentType?: string | null
  principalId?: string | null
}): string {
  return [g.clientId ?? '', g.resourceId ?? '', g.consentType ?? '', g.principalId ?? ''].join('|').toLowerCase()
}

/** Normalize a space-delimited scope string for order-insensitive comparison. */
export function normalizeScope(scope: string | undefined): string {
  return (scope ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

export function extractOAuth2GrantSpecs(canvas: CanvasSnapshot): OAuth2GrantSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      clientId: asString(f.clientId),
      resourceId: asString(f.resourceId),
      consentType: asString(f.consentType) || 'AllPrincipals',
      principalId: asString(f.principalId),
      scope: asString(f.scope),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractOAuth2GrantSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.clientId) errors.push({ field: `${prefix}.clientId`, message: 'Client (service principal) ID is required', code: 'required' })
    if (!spec.resourceId) errors.push({ field: `${prefix}.resourceId`, message: 'Resource (API service principal) ID is required', code: 'required' })
    if (!spec.scope) errors.push({ field: `${prefix}.scope`, message: 'Scope is required', code: 'required' })

    if (!CONSENT_TYPES.has(spec.consentType)) {
      errors.push({
        field: `${prefix}.consentType`,
        message: `Consent type must be one of ${[...CONSENT_TYPES].join(', ')}`,
        code: 'invalid_consent_type',
      })
    }
    if (spec.consentType === 'Principal' && !spec.principalId) {
      errors.push({
        field: `${prefix}.principalId`,
        message: 'Principal ID is required when consent type is Principal',
        code: 'principal_required',
      })
    }
    if (spec.consentType === 'AllPrincipals' && spec.principalId) {
      warnings.push({
        field: `${prefix}.principalId`,
        message: 'Principal ID is ignored when consent type is AllPrincipals',
        code: 'principal_ignored',
      })
    }

    if (spec.clientId && spec.resourceId) {
      const key = grantKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.clientId`,
          message: 'Duplicate grant (same client, resource, consent type and principal) — declare it once per canvas',
          code: 'duplicate_grant',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
