import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Identity Providers (IdP) API constraints ---------------------------

/**
 * The identity-provider types this config type manages (canvas select values).
 * `type` is the IdP kind; the nested `protocol.type` (OIDC | SAML2 | OAUTH2 | …)
 * is a separate, protocol-level discriminator authored inside protocolJson.
 */
export const IDP_TYPES = [
  'OIDC',
  'SAML2',
  'GOOGLE',
  'FACEBOOK',
  'MICROSOFT',
  'APPLE',
  'LINKEDIN',
  'X509',
] as const
export type IdpType = (typeof IDP_TYPES)[number]

/** An IdP is ACTIVE or INACTIVE; status is changed via the lifecycle endpoints. */
export const IDP_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** An IdP name is capped at 100 characters. */
export const MAX_IDP_NAME_LENGTH = 100

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IdpSpec {
  sectionName: string
  /** IdP kind — OIDC | SAML2 | GOOGLE | … ; part of the create/update body. */
  type: string
  /** IdP name — the logical identity deploy matches on. */
  name: string
  /** Desired lifecycle status — ACTIVE | INACTIVE. */
  status: string
  /**
   * Raw JSON string of the protocol object (endpoints, scopes, credentials).
   * Parsed to an object and sent as `protocol` on create/update.
   *
   * SENSITIVE: the OAuth/OIDC client secret lives at
   * `credentials.client.client_secret`. Okta stores it write-only and NEVER
   * returns it on a GET, so it is deliberately excluded from drift detection
   * (see stripClientSecret + driftDetect).
   */
  protocolJson?: string
  /**
   * Raw JSON string of the policy object (provisioning, accountLink, subject
   * mapping). Parsed to an object and sent as `policy` on create/update.
   */
  policyJson?: string
}

/**
 * Shape of an IdP returned by GET /idps. Carries an index signature so the live
 * IdP can be handed to helpers typed as `Record<string, unknown>` and so
 * server-managed keys are readable.
 */
export interface LiveIdp {
  id?: string
  name?: string
  type?: string
  status?: string
  system?: boolean
  created?: string
  lastUpdated?: string
  protocol?: Record<string, unknown>
  policy?: Record<string, unknown>
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not a
 * JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the API body).
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

/** Each canvas item describes one Okta identity provider. */
export function extractIdpSpecs(canvas: CanvasSnapshot): IdpSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const protocolJson =
      typeof fields.protocolJson === 'string' && fields.protocolJson.trim()
        ? fields.protocolJson.trim()
        : undefined
    const policyJson =
      typeof fields.policyJson === 'string' && fields.policyJson.trim()
        ? fields.policyJson.trim()
        : undefined

    return {
      sectionName: section.name,
      // IdP types/statuses are upper-case enums; normalise so a lower-case
      // entry still matches instead of failing as "invalid".
      type: typeof fields.type === 'string' ? fields.type.trim().toUpperCase() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      status: typeof fields.status === 'string' ? fields.status.trim().toUpperCase() : 'ACTIVE',
      protocolJson,
      policyJson,
    }
  })
}

/**
 * Return a deep copy of a protocol object WITHOUT the write-only OAuth/OIDC
 * client secret at `credentials.client.client_secret`.
 *
 * Okta never echoes the client secret back on a GET (it is write-only), so any
 * comparison that kept it would ALWAYS report drift against a live protocol that
 * cannot return it. Stripping it from both the authored and the live protocol
 * before diffing is exactly how the secret is excluded from drift detection —
 * it is only ever verified at deploy time, when it is written. Never mutates the
 * input (deep-clones via a JSON round-trip; protocol values are always JSON).
 */
export function stripClientSecret(protocol: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(protocol ?? {})) as Record<string, unknown>
  const credentials = clone.credentials as Record<string, unknown> | undefined
  const client = credentials?.client as Record<string, unknown> | undefined
  if (client && typeof client === 'object' && 'client_secret' in client) {
    delete (client as Record<string, unknown>).client_secret
  }
  return clone
}

/**
 * A light sanity check that the protocol blob carries a `type` (OIDC | SAML2 |
 * OAUTH2 | …), which discriminates Okta's protocol oneOf. Returns an error
 * message, or null when present. Deliberately shallow — it never validates the
 * endpoint/scope/credential shape, only that the protocol is not typeless.
 */
export function checkProtocol(protocol: Record<string, unknown>): string | null {
  const type = protocol.type
  if (typeof type !== 'string' || type.trim() === '') {
    return 'The protocol object needs a "type" (e.g. "OIDC", "OAUTH2" or "SAML2"), which selects the protocol shape — e.g. {"type":"OIDC","endpoints":{…},"scopes":["openid"],"credentials":{"client":{"client_id":"…","client_secret":"…"}}}'
  }
  return null
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate identity-provider configurations against the Okta IdP API. Static
 * only — it never contacts Okta:
 *   - name is required, <= 100 chars, and unique within the canvas
 *   - type is one of the managed IdP types
 *   - status (when set) is ACTIVE | INACTIVE
 *   - protocolJson is required and must parse to a JSON OBJECT carrying a `type`
 *   - policyJson is required and must parse to a JSON OBJECT
 *
 * IdPs are SENSITIVE — a misconfigured provider can break federated sign-in and
 * lock users out. There are no protected/system IdP names to reject (unlike the
 * system network zones / default policy), so identity validation is name-based.
 * The write-only client secret inside protocolJson is authored here but is never
 * drift-checked (see stripClientSecret).
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
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 100 chars, and unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'IdP name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_IDP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `IdP name must be ${MAX_IDP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate IdP "${spec.name}" — each identity provider may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type — required and in the supported enum
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'IdP type is required', code: 'required' })
    } else if (!(IDP_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `IdP type must be one of: ${IDP_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // status — when set, must be ACTIVE or INACTIVE
    if (spec.status && !(IDP_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${IDP_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // protocolJson — required; must parse to a JSON object carrying a `type`. A
    // misconfigured protocol breaks federated sign-in, so it is not optional.
    if (!spec.protocolJson) {
      errors.push({
        field: `${prefix}.protocolJson`,
        message: 'Protocol (JSON) is required — it carries the endpoints, scopes and credentials',
        code: 'required',
      })
    } else {
      const protocol = parseJsonObject(spec.protocolJson)
      if (protocol === null) {
        errors.push({
          field: `${prefix}.protocolJson`,
          message:
            'Protocol must be a valid JSON object, e.g. {"type":"OIDC","endpoints":{…},"scopes":["openid"],"credentials":{"client":{"client_id":"…","client_secret":"…"}}}',
          code: 'invalid_protocol',
        })
      } else {
        const problem = checkProtocol(protocol)
        if (problem) {
          errors.push({ field: `${prefix}.protocolJson`, message: problem, code: 'missing_protocol_type' })
        }
      }
    }

    // policyJson — required; must parse to a JSON object (provisioning /
    // accountLink / subject mapping). Okta rejects an IdP with no policy.
    if (!spec.policyJson) {
      errors.push({
        field: `${prefix}.policyJson`,
        message: 'Policy (JSON) is required — it carries provisioning, account link and subject mapping',
        code: 'required',
      })
    } else if (parseJsonObject(spec.policyJson) === null) {
      errors.push({
        field: `${prefix}.policyJson`,
        message:
          'Policy must be a valid JSON object, e.g. {"provisioning":{"action":"AUTO"},"subject":{"userNameTemplate":{"template":"idpuser.email"},"matchType":"USERNAME"}}',
        code: 'invalid_policy',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
