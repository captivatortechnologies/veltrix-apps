import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asArray, ppErrorMessage, type PPClient } from '../../lib/proofpoint'

// --- Proofpoint Essentials Identity Provider (SSO) constraints ---------------
//
// An Identity Provider (IDP) is a sub-resource of the organization
// (/orgs/{org}/authentication/settings/idps), addressed by a server-assigned
// UUID once created. Identity for reconciliation is the human-readable `name`.
// Every writable field is public SAML metadata — an entity id, login/logout
// URLs and the IDP's own public verification certificate — never a secret (the
// certificate here validates assertions the IDP *sends*; Essentials' own SP
// certificate, `sp_public_cert`, is server-generated and read-only). See the
// Essentials Interface API OpenAPI document
// (https://{stack}.proofpointessentials.com/apidocs/apidocs/docs), tag
// "authentication", schemas IdpPresenter / IdpTransformer.

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// A loose http(s) URL check — warned, not failed.
const URL_RE = /^https?:\/\/[^\s]+$/i

export interface IdpSpec {
  sectionName: string
  name: string
  isActive: boolean
  description: string
  iconRef: string
  idpEntityId: string
  idpLoginUrl: string
  idpLogoutUrl: string
  idpPublicCert: string
}

/** Shape of an IDP returned by GET /orgs/{org}/authentication/settings/idps. */
export interface LiveIdp {
  id?: string
  name?: string
  is_active?: boolean
  description?: string
  icon_ref?: string
  idp_entity_id?: string
  idp_login_url?: string
  idp_logout_url?: string
  idp_public_cert?: string
}

/** The IDP name (lower-cased) — an IDP's logical identity in an org. */
export function idpKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item describes one Identity Provider. */
export function extractIdpSpecs(canvas: CanvasSnapshot): IdpSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readString(fields.name),
      isActive: readBool(fields.is_active, true),
      description: readString(fields.description),
      iconRef: readString(fields.icon_ref),
      idpEntityId: readString(fields.idp_entity_id),
      idpLoginUrl: readString(fields.idp_login_url),
      idpLogoutUrl: readString(fields.idp_logout_url),
      idpPublicCert: readString(fields.idp_public_cert),
    }
  })
}

/** Build the POST/PUT request body (IdpTransformer shape) for a declared IDP. */
export function buildIdpBody(spec: IdpSpec): Record<string, unknown> {
  return {
    name: spec.name,
    is_active: spec.isActive,
    description: spec.description,
    icon_ref: spec.iconRef,
    idp_entity_id: spec.idpEntityId,
    idp_login_url: spec.idpLoginUrl,
    idp_logout_url: spec.idpLogoutUrl,
    idp_public_cert: spec.idpPublicCert,
  }
}

// --- IDP list I/O (shared by deploy / rollback / healthCheck / drift) --------

/** List all Identity Providers in the configured org; throws on a non-OK response. */
export async function listIdps(client: PPClient): Promise<LiveIdp[]> {
  const res = await client.request('GET', `${client.orgPath}/authentication/settings/idps`)
  if (!res.ok) throw new Error(`Failed to list Identity Providers: ${ppErrorMessage(res)}`)
  return asArray<LiveIdp>(res.body, 'idps')
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Identity Provider configurations: the name is required and must be
 * unique across the canvas; the entity id / login / logout URLs are warned (not
 * failed) when they don't look like URLs; and an active IDP with no public
 * certificate is warned (SAML assertion validation will fail until one is set).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIdpSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = idpKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate IDP name "${spec.name}" — each IDP may only be declared once`, code: 'duplicate_name' })
      }
      seen.add(key)
    }

    for (const [field, value] of [
      ['idp_entity_id', spec.idpEntityId],
      ['idp_login_url', spec.idpLoginUrl],
      ['idp_logout_url', spec.idpLogoutUrl],
    ] as const) {
      if (value && !URL_RE.test(value) && field !== 'idp_entity_id') {
        warnings.push({ field: `${prefix}.${field}`, message: `"${value}" does not look like a URL`, code: 'url_format' })
      }
    }

    if (spec.isActive && !spec.idpPublicCert) {
      warnings.push({
        field: `${prefix}.idp_public_cert`,
        message: `IDP "${spec.name}" is active but has no public certificate — SAML assertion validation will fail until one is set`,
        code: 'missing_cert',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
