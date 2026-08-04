import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asObject, ppErrorMessage, type PPClient } from '../../lib/proofpoint'

// --- Proofpoint Essentials authentication settings constraints ---------------
//
// Organization-wide singleton covering two dedicated sub-resources:
//   /orgs/{org}/authentication/settings/mfa    { is_mfa_enabled, mfa_admins_only }
//   /orgs/{org}/authentication/settings/login  { allow_local_login, idp_for_forced_login,
//                                                 allow_azure_login, force_azure_login }
// Both are read via GET and updated via PUT, and are always fully declared (every
// field has an explicit default) so a deploy never sends a partial/ambiguous body.
// See the Essentials Interface API OpenAPI document
// (https://{stack}.proofpointessentials.com/apidocs/apidocs/docs), tags
// "authentication" / operations getMfaSettings, putMfaSettings, getLoginSettings,
// putLoginSettings.

// A loose UUID shape check (Essentials IDP ids are UUIDs) — warned, not failed,
// since a future IDP id format is not this app's contract to enforce.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AuthSettingsSpec {
  isMfaEnabled: boolean
  mfaAdminsOnly: boolean
  allowLocalLogin: boolean
  allowAzureLogin: boolean
  forceAzureLogin: boolean
  idpForForcedLogin: string
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

/** The singleton item's fields, or field defaults when no item is declared. */
export function extractAuthSettingsSpec(canvas: CanvasSnapshot): AuthSettingsSpec {
  const fields = (canvas.sections ?? [])[0]?.fields ?? {}
  return {
    isMfaEnabled: readBool(fields.is_mfa_enabled, false),
    mfaAdminsOnly: readBool(fields.mfa_admins_only, false),
    allowLocalLogin: readBool(fields.allow_local_login, true),
    allowAzureLogin: readBool(fields.allow_azure_login, true),
    forceAzureLogin: readBool(fields.force_azure_login, false),
    idpForForcedLogin: typeof fields.idp_for_forced_login === 'string' ? fields.idp_for_forced_login.trim() : '',
  }
}

// --- MFA / Login settings I/O (shared by deploy / rollback / healthCheck / drift)

export interface MfaSettings {
  is_mfa_enabled: boolean
  mfa_admins_only: boolean
}

export interface LoginSettings {
  allow_local_login: boolean
  idp_for_forced_login: string | null
  allow_azure_login: boolean
  force_azure_login: boolean
}

/** Read the org's current MFA settings; throws on a non-OK response. */
export async function getMfaSettings(client: PPClient): Promise<MfaSettings> {
  const res = await client.request('GET', `${client.orgPath}/authentication/settings/mfa`)
  if (!res.ok) throw new Error(`Failed to read MFA settings: ${ppErrorMessage(res)}`)
  const body = asObject(res.body)
  return { is_mfa_enabled: readBool(body.is_mfa_enabled, false), mfa_admins_only: readBool(body.mfa_admins_only, false) }
}

/** Read the org's current Login/SSO settings; throws on a non-OK response. */
export async function getLoginSettings(client: PPClient): Promise<LoginSettings> {
  const res = await client.request('GET', `${client.orgPath}/authentication/settings/login`)
  if (!res.ok) throw new Error(`Failed to read Login settings: ${ppErrorMessage(res)}`)
  const body = asObject(res.body)
  return {
    allow_local_login: readBool(body.allow_local_login, true),
    idp_for_forced_login: typeof body.idp_for_forced_login === 'string' && body.idp_for_forced_login ? body.idp_for_forced_login : null,
    allow_azure_login: readBool(body.allow_azure_login, true),
    force_azure_login: readBool(body.force_azure_login, false),
  }
}

/** Build the MFA PUT body from a declared spec. */
export function buildMfaBody(spec: AuthSettingsSpec): MfaSettings {
  return { is_mfa_enabled: spec.isMfaEnabled, mfa_admins_only: spec.mfaAdminsOnly }
}

/** Build the Login PUT body from a declared spec. */
export function buildLoginBody(spec: AuthSettingsSpec): LoginSettings {
  return {
    allow_local_login: spec.allowLocalLogin,
    idp_for_forced_login: spec.idpForForcedLogin || null,
    allow_azure_login: spec.allowAzureLogin,
    force_azure_login: spec.forceAzureLogin,
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate the Authentication Settings singleton: at most one declared item; a
 * forced-login IDP that looks like a UUID (warned, not failed); a sanity check
 * that force_azure_login implies allow_azure_login; and — most importantly — a
 * hard error if the declared settings would leave the organization with no way
 * to log in at all (local login disabled, Azure login disabled, and no forced
 * SSO IDP configured).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Add the Authentication Settings item', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({
      field: 'sections',
      message: 'Authentication Settings is a singleton — declare it only once per canvas',
      code: 'singleton',
    })
  }

  const spec = extractAuthSettingsSpec(ctx.canvas)
  const prefix = sections[0].name

  if (spec.idpForForcedLogin && !UUID_RE.test(spec.idpForForcedLogin)) {
    warnings.push({
      field: `${prefix}.idp_for_forced_login`,
      message: `"${spec.idpForForcedLogin}" does not look like an Identity Provider UUID`,
      code: 'idp_format',
    })
  }

  if (spec.forceAzureLogin && !spec.allowAzureLogin) {
    warnings.push({
      field: `${prefix}.force_azure_login`,
      message: 'Force Azure AD login is enabled while Allow native Azure AD login is disabled — this combination is contradictory',
      code: 'force_azure_conflict',
    })
  }

  if (!spec.allowLocalLogin && !spec.allowAzureLogin && !spec.idpForForcedLogin) {
    errors.push({
      field: `${prefix}.allow_local_login`,
      message:
        'Local login and Azure AD login are both disabled and no forced SSO Identity Provider is set — ' +
        'this would leave the organization with no way to log in. Enable one login method.',
      code: 'no_login_method',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
