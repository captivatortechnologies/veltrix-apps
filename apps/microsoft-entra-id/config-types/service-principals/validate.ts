import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra servicePrincipal (enterprise application) constraints --------------
//
// A service principal is the tenant-local instance of an application, identified
// by its `appId`. An SP already exists for any installed enterprise app, so the
// reconcile key is `appId` and deploy is usually PATCH-existing, not create.

/** preferredSingleSignOnMode values Graph accepts; '' / null means "none". */
export const SSO_MODES = new Set(['password', 'saml', 'notSupported', 'oidc'])

/** appId is the GUID of the application this service principal represents. */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export const SP_BASE = '/servicePrincipals'
/** The projection deploy + drift read; keep in sync with LiveServicePrincipal. */
export const SP_SELECT =
  'id,appId,displayName,accountEnabled,appRoleAssignmentRequired,preferredSingleSignOnMode,homepage,notificationEmailAddresses,tags,servicePrincipalType'

export interface ServicePrincipalSpec {
  itemId?: string
  /** appId of the represented application — the reconcile key. */
  appId: string
  accountEnabled: boolean
  appRoleAssignmentRequired: boolean
  /** A value from SSO_MODES, or '' for none/null. */
  preferredSingleSignOnMode: string
  homepage: string
  notificationEmailAddresses: string[]
  tags: string[]
  /** Owner object ids, UPNs or display names (users or service principals) — resolved at deploy time. */
  owners: string[]
}

/** A servicePrincipal as returned by Graph GET /servicePrincipals. */
export interface LiveServicePrincipal {
  id?: string
  appId?: string
  displayName?: string
  accountEnabled?: boolean
  appRoleAssignmentRequired?: boolean
  preferredSingleSignOnMode?: string | null
  homepage?: string | null
  notificationEmailAddresses?: string[]
  tags?: string[]
  servicePrincipalType?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Boolean field read with an explicit default for the unset case. */
function asBool(v: unknown, dflt: boolean): boolean {
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  return dflt
}

/** Split a textarea/text value into trimmed, non-empty tokens (by newline or comma). */
function splitTokens(v: unknown): string[] {
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** The effective SSO mode: a recognized value, else '' (none). */
export function effectiveSsoMode(spec: { preferredSingleSignOnMode: string }): string {
  return SSO_MODES.has(spec.preferredSingleSignOnMode) ? spec.preferredSingleSignOnMode : ''
}

/** Normalize a string collection for order-insensitive comparison. */
export function normalizeList(values: string[] | null | undefined): string {
  return [...(values ?? [])]
    .map((v) => v.trim())
    .filter(Boolean)
    .sort()
    .join('\n')
}

/** Build a GET path filtering servicePrincipals to a single appId (an alternate key). */
export function findByAppIdPath(appId: string): string {
  const filter = `appId eq '${appId.replace(/'/g, "''")}'`
  return `${SP_BASE}?$filter=${encodeURIComponent(filter)}&$select=${SP_SELECT}`
}

export function extractServicePrincipalSpecs(canvas: CanvasSnapshot): ServicePrincipalSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      appId: asString(f.appId),
      accountEnabled: asBool(f.accountEnabled, true),
      appRoleAssignmentRequired: asBool(f.appRoleAssignmentRequired, false),
      preferredSingleSignOnMode: asString(f.preferredSingleSignOnMode),
      homepage: asString(f.homepage),
      notificationEmailAddresses: splitTokens(f.notificationEmailAddresses),
      tags: splitTokens(f.tags),
      owners: splitTokens(f.owners),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractServicePrincipalSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // appId — required, GUID, unique within the canvas.
    if (!spec.appId) {
      errors.push({ field: `${prefix}.appId`, message: 'App ID is required', code: 'required' })
    } else {
      if (!GUID_RE.test(spec.appId)) {
        errors.push({
          field: `${prefix}.appId`,
          message: 'App ID must be a GUID — the appId of the application this service principal represents',
          code: 'invalid_guid',
        })
      }
      const key = spec.appId.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.appId`,
          message: `Duplicate app ID "${spec.appId}" — each service principal may be declared once per canvas`,
          code: 'duplicate_app_id',
        })
      }
      seen.add(key)
    }

    // preferredSingleSignOnMode — a recognized mode when set.
    if (spec.preferredSingleSignOnMode && !SSO_MODES.has(spec.preferredSingleSignOnMode)) {
      errors.push({
        field: `${prefix}.preferredSingleSignOnMode`,
        message: `Single sign-on mode must be one of ${[...SSO_MODES].join(', ')}`,
        code: 'invalid_sso_mode',
      })
    }

    // notificationEmailAddresses — each must look like an email.
    spec.notificationEmailAddresses.forEach((email, j) => {
      if (!EMAIL_RE.test(email)) {
        errors.push({
          field: `${prefix}.notificationEmailAddresses[${j}]`,
          message: `"${email}" is not a valid email address`,
          code: 'invalid_email',
        })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
