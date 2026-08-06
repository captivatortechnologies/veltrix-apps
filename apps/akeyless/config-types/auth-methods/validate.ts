import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { toStringList } from '../../lib/akeyless'

// --- Akeyless Auth Methods API constraints ------------------------------------
// https://docs.akeyless.io - operations auth-method-create-{type}/-update-{type}/
// -get/-delete/-list, one pair of endpoints per type (api-key, aws-iam,
// azure-ad, k8s, oidc). An auth method's identity is its NAME; type is
// immutable once created (see canvas.yaml header for why).

export const AUTH_METHOD_TYPES = ['api-key', 'aws-iam', 'azure-ad', 'k8s', 'oidc'] as const
export type AuthMethodType = (typeof AUTH_METHOD_TYPES)[number]

export interface AuthMethodSpec {
  sectionName: string
  name: string
  type: AuthMethodType | ''
  description: string
  accessExpires: number
  boundIps: string[]
  gwBoundIps: string[]
  forceSubClaims: boolean
  jwtTtl: number
  allowedClientType: string[]
  productType: string[]
  auditLogsClaims: string[]
  expirationEventIn: string[]
  deleteProtection: boolean
  // aws-iam
  boundAwsAccountId: string[]
  stsUrl: string
  boundArn: string[]
  boundRoleName: string[]
  boundRoleId: string[]
  boundResourceId: string[]
  boundUserName: string[]
  boundUserId: string[]
  uniqueIdentifierAwsIam: string
  // azure-ad
  boundTenantId: string
  issuerAzureAd: string
  jwksUri: string
  audienceAzureAd: string
  boundSpid: string[]
  boundGroupId: string[]
  boundSubId: string[]
  boundRgId: string[]
  boundProviders: string[]
  boundResourceTypes: string[]
  boundResourceNames: string[]
  boundResourceIdAzureAd: string[]
  uniqueIdentifierAzureAd: string
  // k8s
  audienceK8s: string
  boundSaNames: string[]
  boundPodNames: string[]
  boundNamespaces: string[]
  publicKey: string
  // oidc
  issuerOidc: string
  clientId: string
  clientSecret: string
  uniqueIdentifierOidc: string
  allowedRedirectUri: string[]
  requiredScopes: string[]
  requiredScopesPrefix: string
  audienceOidc: string
  subclaimsDelimiters: string[]
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function bool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Each canvas item describes one Akeyless auth method. */
export function extractAuthMethodSpecs(canvas: CanvasSnapshot): AuthMethodSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const f = (section.fields ?? {}) as Record<string, unknown>
    return {
      sectionName: section.name,
      name: str(f.name),
      type: (AUTH_METHOD_TYPES as readonly string[]).includes(str(f.type)) ? (str(f.type) as AuthMethodType) : '',
      description: str(f.description),
      accessExpires: num(f.accessExpires),
      boundIps: toStringList(f.boundIps),
      gwBoundIps: toStringList(f.gwBoundIps),
      forceSubClaims: bool(f.forceSubClaims),
      jwtTtl: num(f.jwtTtl),
      allowedClientType: toStringList(f.allowedClientType),
      productType: toStringList(f.productType),
      auditLogsClaims: toStringList(f.auditLogsClaims),
      expirationEventIn: toStringList(f.expirationEventIn),
      deleteProtection: bool(f.deleteProtection),
      boundAwsAccountId: toStringList(f.boundAwsAccountId),
      stsUrl: str(f.stsUrl) || 'https://sts.amazonaws.com',
      boundArn: toStringList(f.boundArn),
      boundRoleName: toStringList(f.boundRoleName),
      boundRoleId: toStringList(f.boundRoleId),
      boundResourceId: toStringList(f.boundResourceId),
      boundUserName: toStringList(f.boundUserName),
      boundUserId: toStringList(f.boundUserId),
      uniqueIdentifierAwsIam: str(f.uniqueIdentifierAwsIam),
      boundTenantId: str(f.boundTenantId),
      issuerAzureAd: str(f.issuerAzureAd),
      jwksUri: str(f.jwksUri),
      audienceAzureAd: str(f.audienceAzureAd),
      boundSpid: toStringList(f.boundSpid),
      boundGroupId: toStringList(f.boundGroupId),
      boundSubId: toStringList(f.boundSubId),
      boundRgId: toStringList(f.boundRgId),
      boundProviders: toStringList(f.boundProviders),
      boundResourceTypes: toStringList(f.boundResourceTypes),
      boundResourceNames: toStringList(f.boundResourceNames),
      boundResourceIdAzureAd: toStringList(f.boundResourceIdAzureAd),
      uniqueIdentifierAzureAd: str(f.uniqueIdentifierAzureAd),
      audienceK8s: str(f.audienceK8s),
      boundSaNames: toStringList(f.boundSaNames),
      boundPodNames: toStringList(f.boundPodNames),
      boundNamespaces: toStringList(f.boundNamespaces),
      publicKey: str(f.publicKey),
      issuerOidc: str(f.issuerOidc),
      clientId: str(f.clientId),
      clientSecret: str(f.clientSecret),
      uniqueIdentifierOidc: str(f.uniqueIdentifierOidc),
      allowedRedirectUri: toStringList(f.allowedRedirectUri),
      requiredScopes: toStringList(f.requiredScopes),
      requiredScopesPrefix: str(f.requiredScopesPrefix),
      audienceOidc: str(f.audienceOidc),
      subclaimsDelimiters: toStringList(f.subclaimsDelimiters),
    }
  })
}

/**
 * Detect an EXISTING Akeyless auth method's type from its `access_info`
 * (POST /auth-method-get response) - there is no single top-level "type"
 * field, but exactly one of the per-type `*_access_rules` sub-objects is
 * populated. Used by deploy.ts/driftDetect.ts to refuse an in-place type
 * change (see canvas.yaml header).
 */
export function detectLiveAuthMethodType(accessInfo: Record<string, unknown> | undefined | null): AuthMethodType | 'unknown' {
  if (!accessInfo) return 'unknown'
  if (accessInfo.api_key_access_rules) return 'api-key'
  if (accessInfo.aws_iam_access_rules) return 'aws-iam'
  if (accessInfo.azure_ad_access_rules) return 'azure-ad'
  if (accessInfo.k8s_access_rules) return 'k8s'
  if (accessInfo.oidc_access_rules) return 'oidc'
  return 'unknown'
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAuthMethodSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate auth method "${spec.name}" - each name may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    if (spec.name) seenNames.add(spec.name)

    if (!spec.type) {
      errors.push({
        field: `${prefix}.type`,
        message: `Type is required and must be one of: ${AUTH_METHOD_TYPES.join(', ')}`,
        code: 'required',
      })
      continue
    }

    if (spec.accessExpires < 0) {
      errors.push({ field: `${prefix}.accessExpires`, message: 'Access Expiration cannot be negative', code: 'invalid_value' })
    }
    if (spec.jwtTtl < 0) {
      errors.push({ field: `${prefix}.jwtTtl`, message: 'JWT TTL cannot be negative', code: 'invalid_value' })
    }
    for (const day of spec.expirationEventIn) {
      if (!/^\d+$/.test(day)) {
        errors.push({
          field: `${prefix}.expirationEventIn`,
          message: `Expiration Notification entries must be whole numbers of days (got "${day}")`,
          code: 'invalid_value',
        })
      }
    }

    if (spec.type === 'aws-iam' && spec.boundAwsAccountId.length === 0) {
      errors.push({
        field: `${prefix}.boundAwsAccountId`,
        message: 'AWS IAM auth methods require at least one Bound AWS Account ID',
        code: 'required',
      })
    }
    if (spec.type === 'azure-ad' && !spec.boundTenantId) {
      errors.push({ field: `${prefix}.boundTenantId`, message: 'Azure AD auth methods require a Bound Tenant ID', code: 'required' })
    }
    if (spec.type === 'oidc' && !spec.issuerOidc) {
      errors.push({ field: `${prefix}.issuerOidc`, message: 'OIDC auth methods require an Issuer', code: 'required' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
