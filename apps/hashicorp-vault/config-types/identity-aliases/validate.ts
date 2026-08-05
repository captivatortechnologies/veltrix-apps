import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault identity alias constraints -----------------------------------------
//
// See: https://developer.hashicorp.com/vault/api-docs/secret/identity/entity-alias
//  and https://developer.hashicorp.com/vault/api-docs/secret/identity/group-alias
//
// An alias binds an EXTERNAL identity (a login from a specific auth mount) to a
// Vault identity ENTITY or GROUP. Its real identity is a server-assigned `id`
// UUID with NO name-in-path form — like a login-MFA method (config-types/
// mfa-methods), it is reconciled by a LABEL instead: the composite of `name`
// (the external identity's login/subject within the mount) and `mountAccessor`
// (which auth mount it came from).

/** The two Vault alias kinds this config type manages, each its own API namespace. */
export const ALIAS_KINDS = ['entity', 'group'] as const
export type AliasKind = (typeof ALIAS_KINDS)[number]

/** Shape of a UUID (canonical_id / mfa method ids are UUIDs; used only for a soft warning). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An accessor looks like "auth_userpass_1a2b3c4d" — a type prefix + hex suffix. */
export const ACCESSOR_PATTERN = /^[a-z0-9]+_[a-z0-9]+_[0-9a-f]{6,}$/i

/** Max length for the alias `name` (an external login/subject, format varies widely). */
export const MAX_NAME_LENGTH = 512

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IdentityAliasSpec {
  sectionName: string
  /** 'entity' | 'group' — selects /identity/entity-alias vs /identity/group-alias. */
  kind: AliasKind | ''
  /** The external identity's login/subject within the mount — the RECONCILIATION label. */
  name: string
  /** entity_id (kind=entity) or group_id (kind=group) this alias points to. */
  canonicalId: string
  /** Accessor of the auth mount this alias belongs to — the other half of the reconciliation key. */
  mountAccessor: string
  /**
   * Optional custom metadata (flat JSON object of string values). Only
   * meaningful for an ENTITY alias — Vault's group-alias API has no
   * custom_metadata input, so this is ignored (with a warning) for kind=group.
   */
  customMetadataJson?: string
}

/**
 * Shape of an alias returned by GET /identity/{kind}-alias/id/{id} (under
 * `data`). Server-computed fields (id, creation_time, mount_path, mount_type,
 * local, merged_from_canonical_ids, metadata) are modeled loosely and are
 * never diffed — only the authored fields (name, canonical_id, mount_accessor,
 * custom_metadata) are compared.
 */
export interface LiveIdentityAlias {
  id?: string
  name?: string
  canonical_id?: string
  mount_accessor?: string
  custom_metadata?: Record<string, unknown> | null
  [key: string]: unknown
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Normalize a raw kind value to a known AliasKind, or '' when unrecognized. */
function normalizeKind(value: unknown): AliasKind | '' {
  const k = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (ALIAS_KINDS as readonly string[]).includes(k) ? (k as AliasKind) : ''
}

/** The composite reconciliation key "kind/mountAccessor/name" — dedup + match key. */
export function aliasKey(kind: string, mountAccessor: string, name: string): string {
  return `${kind}/${mountAccessor}/${name}`
}

/**
 * Parse a raw metadata string, returning the object or null when it is not a
 * JSON object (an array or primitive counts as invalid).
 */
export function parseMetadataObject(raw: string): Record<string, unknown> | null {
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

/** Resolve authored metadata to Vault's map[string]string; blank/invalid ⇒ {}. */
export function resolveMetadata(metadataJson: string | undefined): Record<string, string> {
  if (!metadataJson) return {}
  const parsed = parseMetadataObject(metadataJson)
  if (!parsed) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (v === undefined || v === null) continue
    out[k] = typeof v === 'string' ? v : String(v)
  }
  return out
}

/** Each canvas section describes one Vault identity alias. */
export function extractIdentityAliasSpecs(canvas: CanvasSnapshot): IdentityAliasSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      kind: normalizeKind(fields.kind),
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      canonicalId: typeof fields.canonicalId === 'string' ? fields.canonicalId.trim() : '',
      mountAccessor: typeof fields.mountAccessor === 'string' ? fields.mountAccessor.trim() : '',
      customMetadataJson: optionalString(fields.customMetadataJson),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate identity alias configurations against Vault's constraints (no
 * network): kind, name, canonicalId and mountAccessor are required; the
 * composite (kind, mountAccessor, name) — the reconciliation key this app uses
 * in place of a real addressable identity — is unique per canvas.
 * canonicalId/mountAccessor shapes are checked with a soft WARNING only (they
 * are looked up from live entities/groups/auth mounts elsewhere in Vault, not
 * validated statically). customMetadataJson is only meaningful for kind=entity
 * — it is accepted but flagged as ignored for kind=group.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIdentityAliasSpecs(ctx.canvas)
  const seenKeys = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // kind — required, one of entity | group
    if (!spec.kind) {
      errors.push({ field: `${prefix}.kind`, message: 'Alias kind is required (entity or group)', code: 'required' })
    }

    // name — required, capped (external identifiers vary widely in format).
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Alias name is required (the external login/subject)', code: 'required' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({ field: `${prefix}.name`, message: `Alias name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'max_length' })
    }

    // canonicalId — required; soft warning if not UUID-shaped.
    if (!spec.canonicalId) {
      errors.push({
        field: `${prefix}.canonicalId`,
        message: 'Canonical ID is required — the entity_id (kind=entity) or group_id (kind=group) this alias points to',
        code: 'required',
      })
    } else if (!UUID_PATTERN.test(spec.canonicalId)) {
      warnings.push({
        field: `${prefix}.canonicalId`,
        message: `Canonical ID "${spec.canonicalId}" is not UUID-shaped — Vault entity/group ids are server-assigned UUIDs`,
        code: 'suspicious_canonical_id',
      })
    }

    // mountAccessor — required; soft warning if it doesn't look like an accessor.
    if (!spec.mountAccessor) {
      errors.push({
        field: `${prefix}.mountAccessor`,
        message: 'Mount accessor is required — the auth mount this alias belongs to (e.g. auth_userpass_1a2b3c4d)',
        code: 'required',
      })
    } else if (!ACCESSOR_PATTERN.test(spec.mountAccessor)) {
      warnings.push({
        field: `${prefix}.mountAccessor`,
        message: `Mount accessor "${spec.mountAccessor}" does not look like a Vault accessor (e.g. auth_userpass_1a2b3c4d)`,
        code: 'suspicious_accessor',
      })
    }

    // (kind, mountAccessor, name) is the reconciliation key — dedupe on it.
    if (spec.kind && spec.mountAccessor && spec.name) {
      const key = aliasKey(spec.kind, spec.mountAccessor, spec.name)
      if (seenKeys.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate alias "${key}" — each (kind, mount accessor, name) alias may only be declared once per canvas`,
          code: 'duplicate_alias',
        })
      }
      seenKeys.add(key)
    }

    // customMetadataJson — only meaningful for entity aliases.
    if (spec.customMetadataJson !== undefined) {
      if (spec.kind === 'group') {
        warnings.push({
          field: `${prefix}.customMetadataJson`,
          message: 'Custom metadata is only supported for entity aliases — it is ignored for a group alias',
          code: 'metadata_ignored',
        })
      } else {
        const parsed = parseMetadataObject(spec.customMetadataJson)
        if (parsed === null) {
          errors.push({
            field: `${prefix}.customMetadataJson`,
            message: 'Custom metadata must be a JSON object, e.g. {"source":"okta"}',
            code: 'invalid_metadata',
          })
        } else {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v !== 'string') {
              errors.push({
                field: `${prefix}.customMetadataJson`,
                message: `Custom metadata value for "${k}" must be a string`,
                code: 'invalid_metadata_value',
              })
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
