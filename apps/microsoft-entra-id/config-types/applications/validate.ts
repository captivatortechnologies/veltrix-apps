import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra application-registration constraints ------------------------------

export const MAX_DISPLAY_NAME_LENGTH = 256
export const MAX_UNIQUE_NAME_LENGTH = 120

export const SIGN_IN_AUDIENCES = [
  'AzureADMyOrg',
  'AzureADMultipleOrgs',
  'AzureADandPersonalMicrosoftAccount',
  'PersonalMicrosoftAccount',
] as const

export const GROUP_MEMBERSHIP_CLAIMS = ['None', 'SecurityGroup', 'All'] as const

/** uniqueName / derived slug charset — safe inside the OData `(uniqueName='…')`
 *  alternate-key literal and a URL path (no spaces, no quotes). */
const UNIQUE_NAME_RE = /^[A-Za-z0-9._-]+$/

/** appRole fields we manage — `origin` is read-only and deliberately excluded. */
const APP_ROLE_FIELDS = ['allowedMemberTypes', 'description', 'displayName', 'id', 'isEnabled', 'value'] as const

// --- Spec extraction shared by deploy / rollback / driftDetect / healthCheck --

export interface ApplicationSpec {
  itemId?: string
  /** displayName — the logical identity + slug source. */
  name: string
  /** Explicit uniqueName, or '' to derive one from the name. */
  uniqueName: string
  signInAudience: string
  /** Web platform reply URLs. */
  redirectUris: string[]
  /** Single-page-application reply URLs. */
  spaRedirectUris: string[]
  identifierUris: string[]
  /** Raw JSON text for the appRoles array. */
  appRoles: string
  /** Raw JSON text for the requiredResourceAccess array. */
  requiredResourceAccess: string
  /** '' (not managed), None, SecurityGroup or All. */
  groupMembershipClaims: string
  tags: string[]
  /** Owner object ids, UPNs or display names (users or service principals) — resolved at deploy time. */
  owners: string[]
}

/** An application as returned by Graph GET /applications. */
export interface LiveApplication {
  id?: string
  displayName?: string
  uniqueName?: string | null
  signInAudience?: string
  identifierUris?: string[] | null
  web?: { redirectUris?: string[] } | null
  spa?: { redirectUris?: string[] } | null
  appRoles?: Array<Record<string, unknown>> | null
  requiredResourceAccess?: Array<Record<string, unknown>> | null
  groupMembershipClaims?: string | null
  tags?: string[] | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a textarea/text value into trimmed, non-empty tokens (by newline or comma). */
export function splitTokens(v: unknown): string[] {
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** Derive a valid uniqueName from a display name (letters/digits/._- only). */
export function slugifyUniqueName(displayName: string): string {
  return displayName
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, MAX_UNIQUE_NAME_LENGTH)
}

/** The effective uniqueName for a spec: explicit value, else derived from name. */
export function effectiveUniqueName(spec: ApplicationSpec): string {
  return spec.uniqueName || slugifyUniqueName(spec.name)
}

/** Parse a JSON string into an array, or null when it isn't a JSON array.
 *  A blank string is treated as an empty array (nothing declared). */
export function parseJsonArray(text: string): unknown[] | null {
  if (!text || !text.trim()) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function hasText(v: string): boolean {
  return v.trim().length > 0
}

/** Validate an absolute URI (any scheme). Rejects bare hostnames. */
export function isValidUri(value: string): boolean {
  try {
    return Boolean(new URL(value))
  } catch {
    return false
  }
}

// --- Canonicalization for order-insensitive drift comparison -----------------

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

export function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v ?? null))
}

/** Canonical form of a string list — deduped, trimmed, order-insensitive. */
export function canonicalStringList(list: string[]): string {
  return JSON.stringify([...new Set(list.map((s) => s.trim()).filter(Boolean))].sort())
}

/** Canonical form of an appRoles array — projected to managed fields (no
 *  read-only `origin`), member types sorted, roles ordered deterministically. */
export function canonicalAppRoles(roles: unknown[]): string {
  const norm = roles.map((r) => {
    const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {}
    return {
      allowedMemberTypes: Array.isArray(o.allowedMemberTypes)
        ? [...(o.allowedMemberTypes as unknown[])].map(String).sort()
        : [],
      description: o.description ?? null,
      displayName: o.displayName ?? null,
      id: o.id ?? null,
      isEnabled: o.isEnabled ?? true,
      value: o.value ?? null,
    }
  })
  norm.sort((a, b) => canonical(a).localeCompare(canonical(b)))
  return JSON.stringify(norm)
}

/** Canonical form of a requiredResourceAccess array — resourceAppId +
 *  resourceAccess {id,type}, both ordered deterministically. */
export function canonicalRequiredResourceAccess(list: unknown[]): string {
  const norm = list.map((r) => {
    const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {}
    const access = Array.isArray(o.resourceAccess)
      ? (o.resourceAccess as unknown[]).map((a) => {
          const ao = a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
          return { id: ao.id ?? null, type: ao.type ?? null }
        })
      : []
    access.sort((a, b) => canonical(a).localeCompare(canonical(b)))
    return { resourceAppId: o.resourceAppId ?? null, resourceAccess: access }
  })
  norm.sort((a, b) => canonical(a).localeCompare(canonical(b)))
  return JSON.stringify(norm)
}

/** Strip read-only fields from live appRoles so a restore PATCH is accepted. */
export function stripAppRoleReadOnly(roles: Array<Record<string, unknown>>): Record<string, unknown>[] {
  return roles.map((r) => {
    const out: Record<string, unknown> = {}
    for (const k of APP_ROLE_FIELDS) {
      if (r[k] !== undefined) out[k] = r[k]
    }
    return out
  })
}

export function extractApplicationSpecs(canvas: CanvasSnapshot): ApplicationSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      uniqueName: asString(f.uniqueName),
      signInAudience: asString(f.signInAudience) || 'AzureADMyOrg',
      redirectUris: splitTokens(f.redirectUris),
      spaRedirectUris: splitTokens(f.spaRedirectUris),
      identifierUris: splitTokens(f.identifierUris),
      appRoles: asString(f.appRoles),
      requiredResourceAccess: asString(f.requiredResourceAccess),
      groupMembershipClaims: asString(f.groupMembershipClaims),
      tags: splitTokens(f.tags),
      owners: splitTokens(f.owners),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractApplicationSpecs(ctx.canvas)
  const seenNames = new Set<string>()
  const seenUniqueNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // displayName — required, length, uniqueness
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Display name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate application "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // uniqueName — explicit value must be valid + unique; a blank one is derived,
    // but the derived value must be non-empty (an all-symbol name can't slug).
    const unique = effectiveUniqueName(spec)
    if (spec.uniqueName) {
      if (spec.uniqueName.length > MAX_UNIQUE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.uniqueName`,
          message: `Unique name must be ${MAX_UNIQUE_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      if (!UNIQUE_NAME_RE.test(spec.uniqueName)) {
        errors.push({
          field: `${prefix}.uniqueName`,
          message: 'Unique name may contain only letters, digits and . _ - (no spaces)',
          code: 'invalid_unique_name',
        })
      }
    } else if (spec.name && !unique) {
      errors.push({
        field: `${prefix}.uniqueName`,
        message: `Could not derive a unique name from "${spec.name}" — set one explicitly`,
        code: 'invalid_unique_name',
      })
    }
    if (unique) {
      const uk = unique.toLowerCase()
      if (seenUniqueNames.has(uk)) {
        errors.push({
          field: `${prefix}.uniqueName`,
          message: `Duplicate unique name "${unique}" — each app registration needs a distinct unique name`,
          code: 'duplicate_unique_name',
        })
      }
      seenUniqueNames.add(uk)
    }

    // signInAudience — enum
    if (!(SIGN_IN_AUDIENCES as readonly string[]).includes(spec.signInAudience)) {
      errors.push({
        field: `${prefix}.signInAudience`,
        message: `Sign-in audience must be one of: ${SIGN_IN_AUDIENCES.join(', ')}`,
        code: 'invalid_value',
      })
    }

    // groupMembershipClaims — enum when provided
    if (spec.groupMembershipClaims && !(GROUP_MEMBERSHIP_CLAIMS as readonly string[]).includes(spec.groupMembershipClaims)) {
      errors.push({
        field: `${prefix}.groupMembershipClaims`,
        message: `Group membership claims must be one of: ${GROUP_MEMBERSHIP_CLAIMS.join(', ')}`,
        code: 'invalid_value',
      })
    }

    // redirect / identifier URIs — must be valid absolute URIs
    const uriChecks: Array<[string, string[]]> = [
      ['redirectUris', spec.redirectUris],
      ['spaRedirectUris', spec.spaRedirectUris],
      ['identifierUris', spec.identifierUris],
    ]
    for (const [field, list] of uriChecks) {
      list.forEach((uri, u) => {
        if (!isValidUri(uri)) {
          errors.push({
            field: `${prefix}.${field}[${u}]`,
            message: `"${uri}" is not a valid URI`,
            code: 'invalid_uri',
          })
        }
      })
    }

    // appRoles / requiredResourceAccess — valid JSON arrays of objects when provided
    if (hasText(spec.appRoles)) {
      const roles = parseJsonArray(spec.appRoles)
      if (!roles) {
        errors.push({ field: `${prefix}.appRoles`, message: 'App roles must be a JSON array', code: 'invalid_json' })
      } else if (roles.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
        errors.push({
          field: `${prefix}.appRoles`,
          message: 'Each app role must be a JSON object',
          code: 'invalid_json',
        })
      }
    }
    if (hasText(spec.requiredResourceAccess)) {
      const rra = parseJsonArray(spec.requiredResourceAccess)
      if (!rra) {
        errors.push({
          field: `${prefix}.requiredResourceAccess`,
          message: 'Required resource access must be a JSON array',
          code: 'invalid_json',
        })
      } else if (rra.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
        errors.push({
          field: `${prefix}.requiredResourceAccess`,
          message: 'Each required resource access entry must be a JSON object',
          code: 'invalid_json',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
