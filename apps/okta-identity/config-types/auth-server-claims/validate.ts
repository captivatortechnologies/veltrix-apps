import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Authorization Server Claims API constraints -------------------------
//
// A custom token claim is a CHILD of an authorization server. Its endpoints live
// under /authorizationServers/{authServerId}/claims, so a claim's logical
// identity is the PAIR (authServerId, name) — the same name may exist under two
// different authorization servers without collision.

/** Where a claim is injected — into an ID token (IDENTITY) or access token (RESOURCE). */
export const CLAIM_TYPES = ['IDENTITY', 'RESOURCE'] as const
export type ClaimType = (typeof CLAIM_TYPES)[number]

/**
 * How a claim's value is produced:
 *   - EXPRESSION → an Okta Expression Language string (`value`)
 *   - GROUPS     → the user's groups filtered by `value` + `group_filter_type`
 *   - SYSTEM     → an Okta system-defined claim (rarely authored as code)
 */
export const VALUE_TYPES = ['EXPRESSION', 'GROUPS', 'SYSTEM'] as const
export type ValueType = (typeof VALUE_TYPES)[number]

/** value types that require a non-empty `value`. */
export const VALUE_REQUIRED_TYPES = ['EXPRESSION', 'GROUPS'] as const

/** A claim is ACTIVE or INACTIVE; there is NO lifecycle endpoint — set via PUT. */
export const CLAIM_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** Group filter operators — required (and only meaningful) when valueType is GROUPS. */
export const GROUP_FILTER_TYPES = ['CONTAINS', 'EQUALS', 'REGEX', 'STARTS_WITH'] as const

/** Reasonable cap on a claim name. */
export const MAX_CLAIM_NAME_LENGTH = 1024

/**
 * Server-managed read-only fields to strip from a live claim before a PUT
 * (restore) or a drift comparison. NOTE: `status` is authored through the PUT
 * body here (there is no lifecycle endpoint for claims), so it is NOT read-only
 * and is intentionally absent from this list.
 */
export const CLAIM_READONLY_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  'system',
  '_links',
  '_embedded',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift ---------

export interface ClaimSpec {
  sectionName: string
  /** The parent authorization server id (e.g. 'default'); half of the identity. */
  authServerId: string
  /** Claim name — the other half of the (authServerId, name) logical identity. */
  name: string
  /** IDENTITY (ID token) | RESOURCE (access token). */
  claimType: string
  /** EXPRESSION | GROUPS | SYSTEM. */
  valueType: string
  /** The claim value — an EL expression, or (for GROUPS) the group filter pattern. */
  value: string
  /** Whether the claim is always included in the token, not just for its scopes. */
  alwaysIncludeInToken: boolean
  /** Desired status — ACTIVE | INACTIVE (applied through the PUT body). */
  status: string
  /** Scope names the claim is conditioned on → conditions.scopes. */
  scopeConditions: string[]
  /** Group filter operator; '' unless valueType is GROUPS → body group_filter_type. */
  groupFilterType: string
}

/** Shape of a claim returned by GET /authorizationServers/{id}/claims. */
export interface LiveClaim {
  id?: string
  name?: string
  status?: string
  claimType?: string
  valueType?: string
  value?: string
  alwaysIncludeInToken?: boolean
  conditions?: Record<string, unknown>
  group_filter_type?: string
  system?: boolean
  created?: string
  lastUpdated?: string
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/** Canvas list fields (tags) arrive as arrays, or comma/newline text. */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Coerce a canvas checkbox value (boolean, or the string "true"/"false") to a boolean. */
export function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return false
}

/** Each canvas item describes one Okta authorization-server claim. */
export function extractClaimSpecs(canvas: CanvasSnapshot): ClaimSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    return {
      sectionName: section.name,
      authServerId: typeof fields.authServerId === 'string' ? fields.authServerId.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      // claimType / valueType / status / groupFilterType are upper-case enums;
      // normalise so a lower-case entry still matches instead of failing.
      claimType: typeof fields.claimType === 'string' ? fields.claimType.trim().toUpperCase() : '',
      valueType: typeof fields.valueType === 'string' ? fields.valueType.trim().toUpperCase() : '',
      value: typeof fields.value === 'string' ? fields.value.trim() : '',
      alwaysIncludeInToken: toBoolean(fields.alwaysIncludeInToken),
      status:
        typeof fields.status === 'string' && fields.status.trim()
          ? fields.status.trim().toUpperCase()
          : 'ACTIVE',
      scopeConditions: toStringList(fields.scopeConditions),
      groupFilterType:
        typeof fields.groupFilterType === 'string' ? fields.groupFilterType.trim().toUpperCase() : '',
    }
  })
}

/**
 * Build the create/replace claim body (PUT is a full replace; there is no
 * lifecycle endpoint, so `status` lives in the body). The GROUPS-only
 * `group_filter_type` is added only when valueType is GROUPS. `value` is omitted
 * when blank (a SYSTEM claim may carry no author-supplied value).
 */
export function buildClaimBody(spec: ClaimSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    status: spec.status || 'ACTIVE',
    claimType: spec.claimType,
    valueType: spec.valueType,
    alwaysIncludeInToken: spec.alwaysIncludeInToken,
    conditions: { scopes: spec.scopeConditions },
  }
  if (spec.value) body.value = spec.value
  if (spec.valueType === 'GROUPS' && spec.groupFilterType) {
    body.group_filter_type = spec.groupFilterType
  }
  return body
}

/** Copy a live claim without the server-managed read-only fields (safe to PUT back). */
export function stripReadOnlyClaimFields(claim: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(claim)) {
    if (!(CLAIM_READONLY_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate authorization-server claim configurations against the Okta model.
 * Static only — it never contacts Okta:
 *   - authServerId is required (the parent auth server the claim lives under)
 *   - name is required, <= 1024 chars
 *   - claimType is required and one of IDENTITY | RESOURCE
 *   - valueType is required and one of EXPRESSION | GROUPS | SYSTEM
 *   - value is required for EXPRESSION and GROUPS claims
 *   - status, when set, is ACTIVE | INACTIVE
 *   - groupFilterType is required for GROUPS (CONTAINS|EQUALS|REGEX|STARTS_WITH)
 *     and, when supplied on a non-GROUPS claim, is a warning (it is ignored)
 *   - the (authServerId, name) PAIR — a claim's logical identity — is unique per
 *     canvas (the same name under a different auth server is allowed)
 *
 * The "never modify a system:true claim" guard cannot run statically (validate
 * has no live `system` flag) and lives in deploy/drift instead.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractClaimSpecs(ctx.canvas)
  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // authServerId — required; the parent auth server the claim lives under.
    if (!spec.authServerId) {
      errors.push({
        field: `${prefix}.authServerId`,
        message: 'Authorization server id is required — the claim lives under /authorizationServers/{id}/claims (e.g. "default")',
        code: 'required',
      })
    }

    // name — required and <= 1024 chars.
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Claim name is required', code: 'required' })
    } else if (spec.name.length > MAX_CLAIM_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Claim name must be ${MAX_CLAIM_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // claimType — required, one of IDENTITY | RESOURCE.
    if (!spec.claimType) {
      errors.push({ field: `${prefix}.claimType`, message: 'Claim type is required', code: 'required' })
    } else if (!(CLAIM_TYPES as readonly string[]).includes(spec.claimType)) {
      errors.push({
        field: `${prefix}.claimType`,
        message: `Claim type must be one of ${CLAIM_TYPES.join(', ')}`,
        code: 'invalid_claim_type',
      })
    }

    // valueType — required, one of EXPRESSION | GROUPS | SYSTEM.
    if (!spec.valueType) {
      errors.push({ field: `${prefix}.valueType`, message: 'Value type is required', code: 'required' })
    } else if (!(VALUE_TYPES as readonly string[]).includes(spec.valueType)) {
      errors.push({
        field: `${prefix}.valueType`,
        message: `Value type must be one of ${VALUE_TYPES.join(', ')}`,
        code: 'invalid_value_type',
      })
    }

    // value — required for EXPRESSION and GROUPS (SYSTEM claims may omit it).
    if ((VALUE_REQUIRED_TYPES as readonly string[]).includes(spec.valueType) && !spec.value) {
      errors.push({
        field: `${prefix}.value`,
        message: `A ${spec.valueType} claim requires a "value" (${
          spec.valueType === 'GROUPS' ? 'the group filter pattern, e.g. ".*"' : 'an Okta Expression Language string, e.g. appuser.department'
        })`,
        code: 'required',
      })
    }

    // status — when set, must be ACTIVE or INACTIVE.
    if (spec.status && !(CLAIM_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of ${CLAIM_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // groupFilterType — required for GROUPS claims, ignored otherwise.
    if (spec.valueType === 'GROUPS') {
      if (!spec.groupFilterType) {
        errors.push({
          field: `${prefix}.groupFilterType`,
          message: `A GROUPS claim requires a group filter type (one of ${GROUP_FILTER_TYPES.join(', ')})`,
          code: 'required',
        })
      } else if (!(GROUP_FILTER_TYPES as readonly string[]).includes(spec.groupFilterType)) {
        errors.push({
          field: `${prefix}.groupFilterType`,
          message: `Group filter type must be one of ${GROUP_FILTER_TYPES.join(', ')}`,
          code: 'invalid_group_filter',
        })
      }
    } else if (spec.groupFilterType) {
      warnings.push({
        field: `${prefix}.groupFilterType`,
        message: 'Group filter type only applies to GROUPS claims — it will be ignored on deploy',
        code: 'group_filter_ignored',
      })
    }

    // (authServerId, name) PAIR is the claim's logical identity — dedupe on it.
    // A JSON-array key keeps the two halves unambiguous.
    if (spec.authServerId && spec.name) {
      const key = JSON.stringify([spec.authServerId, spec.name])
      if (seenPairs.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate claim "${spec.name}" under authorization server "${spec.authServerId}" — each (authServerId, name) pair may only be declared once per canvas`,
          code: 'duplicate_claim',
        })
      }
      seenPairs.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
