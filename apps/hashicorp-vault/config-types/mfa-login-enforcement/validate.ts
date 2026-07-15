import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault login-MFA enforcement constraints ---------------------------------

/** An enforcement name is letters, digits, underscores and hyphens. It is the identity. */
export const ENFORCEMENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/** Shape of a method_id / entity_id / group_id: an RFC-4122 UUID. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface EnforcementSpec {
  sectionName: string
  /** Enforcement name — the identity, unique per canvas (no surrounding whitespace). */
  name: string
  /** method_id UUIDs required by this enforcement; multiple are ORed together. */
  mfaMethodIds: string[]
  /** Selector: auth method TYPES (e.g. userpass, ldap) this enforcement covers. */
  authMethodTypes: string[]
  /** Selector: auth mount ACCESSORS (e.g. auth_userpass_1a2b3c4d) this covers. */
  authMethodAccessors: string[]
  /** Selector: identity GROUP ids this enforcement covers. */
  identityGroupIds: string[]
  /** Selector: identity ENTITY ids this enforcement covers. */
  identityEntityIds: string[]
}

/**
 * Shape of an enforcement returned by GET /identity/mfa/login-enforcement/{name}
 * (under a `data` wrapper). Server-computed fields (id, namespace_id, name) are
 * excluded from drift; only the authored fields below are compared.
 */
export interface LiveEnforcement {
  mfa_method_ids?: string[]
  auth_method_types?: string[]
  auth_method_accessors?: string[]
  identity_group_ids?: string[]
  identity_entity_ids?: string[]
  name?: string
  id?: string
  namespace_id?: string
}

/** Split a canvas `tags` value (array) or a comma/newline string into trimmed items. */
export function splitList(value: unknown): string[] {
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

/** True when a value has the shape of an RFC-4122 UUID (method/entity/group ids are UUIDs). */
export function looksLikeUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim())
}

/** An enforcement needs AT LEAST ONE selector — a login it applies to. */
export function hasSelector(spec: EnforcementSpec): boolean {
  return (
    spec.authMethodTypes.length > 0 ||
    spec.authMethodAccessors.length > 0 ||
    spec.identityGroupIds.length > 0 ||
    spec.identityEntityIds.length > 0
  )
}

/** Each canvas section describes one login-MFA enforcement. */
export function extractEnforcementSpecs(canvas: CanvasSnapshot): EnforcementSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      // De-dupe each set so the deploy body and drift comparison are stable.
      mfaMethodIds: [...new Set(splitList(fields.mfaMethodIds))],
      authMethodTypes: [...new Set(splitList(fields.authMethodTypes))],
      authMethodAccessors: [...new Set(splitList(fields.authMethodAccessors))],
      identityGroupIds: [...new Set(splitList(fields.identityGroupIds))],
      identityEntityIds: [...new Set(splitList(fields.identityEntityIds))],
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate login-MFA enforcements against Vault's constraints (no network):
 *   - a name (allowed characters), unique per canvas — the enforcement's identity
 *   - at least one mfa_method_id — the methods to require (ORed together)
 *   - at least one selector (auth method types/accessors, identity group/entity
 *     ids) — Vault rejects an enforcement that applies to no logins
 * method_id / entity_id / group_id values are UUIDs; a value that is not
 * UUID-shaped is a warning (the user may be reconciling ids out of band).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractEnforcementSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, allowed characters, unique in canvas (the identity).
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Enforcement name is required', code: 'required' })
    } else {
      if (!ENFORCEMENT_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Enforcement name may contain only letters, digits, underscores and hyphens',
          code: 'invalid_name',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate enforcement name "${spec.name}" — each enforcement may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // mfa_method_ids — at least one required (the methods to require, ORed).
    if (spec.mfaMethodIds.length === 0) {
      errors.push({
        field: `${prefix}.mfaMethodIds`,
        message: 'At least one MFA method id is required — these are the method_id UUIDs the enforcement requires',
        code: 'required',
      })
    } else {
      for (const id of spec.mfaMethodIds) {
        if (!looksLikeUuid(id)) {
          warnings.push({
            field: `${prefix}.mfaMethodIds`,
            message: `MFA method id "${id}" is not a UUID — a login-MFA method_id is a server-assigned UUID (from the mfa-methods config type)`,
            code: 'suspicious_method_id',
          })
        }
      }
    }

    // selectors — at least one required across all four (which logins it applies to).
    if (!hasSelector(spec)) {
      errors.push({
        field: `${prefix}.authMethodTypes`,
        message:
          'At least one selector is required — set an auth method type, auth method accessor, identity group id or identity entity id so the enforcement applies to some login',
        code: 'no_selector',
      })
    }

    // identity group/entity ids are UUIDs; flag non-UUID values as a warning.
    for (const id of spec.identityGroupIds) {
      if (!looksLikeUuid(id)) {
        warnings.push({
          field: `${prefix}.identityGroupIds`,
          message: `Identity group id "${id}" is not a UUID — an identity group id is a server-assigned UUID`,
          code: 'suspicious_group_id',
        })
      }
    }
    for (const id of spec.identityEntityIds) {
      if (!looksLikeUuid(id)) {
        warnings.push({
          field: `${prefix}.identityEntityIds`,
          message: `Identity entity id "${id}" is not a UUID — an identity entity id is a server-assigned UUID`,
          code: 'suspicious_entity_id',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
