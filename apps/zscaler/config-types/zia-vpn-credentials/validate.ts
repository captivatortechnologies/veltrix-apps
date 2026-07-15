import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA VPN Credential constraints ------------------------------------------
//
// A VPN credential authenticates an IPSec tunnel from a location to Zscaler. Its
// identity is CONDITIONAL on the type:
//   * UFQDN → the `fqdn` (a user-fqdn such as site1@acme.com)
//   * IP    → the `ip_address` (a static IP provisioned in ZIA)
// deploy / drift / healthCheck LIST /vpnCredentials and reconcile on that
// identity; ZIA assigns the numeric id.
//
// ⚠ WRITE-ONLY SECRET: `pre_shared_key` (the IPSec PSK) is NEVER returned by ZIA
// on GET. It is re-asserted on every deploy, and is never drift-checked, logged,
// captured for rollback, or stored in artifacts. It is required here because a
// create needs it and validate cannot tell create from update — so the canvas
// must always carry it.

/** The credential types ZIA accepts; each fixes which field is the identity. */
export const VPN_CREDENTIAL_TYPES = ['IP', 'UFQDN'] as const
export type VpnCredentialType = (typeof VPN_CREDENTIAL_TYPES)[number]

/** ZIA caps the fqdn / ip_address at 255 chars and comments at 10240. */
export const MAX_IDENTITY_LENGTH = 255
export const MAX_COMMENTS_LENGTH = 10240

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface VpnCredentialSpec {
  sectionName: string
  /** IP | UFQDN ('' when unset / unrecognized). */
  type: string
  /** UFQDN identity — the user-fqdn (undefined when blank). */
  fqdn?: string
  /** IP identity — the provisioned static IP (undefined when blank). */
  ipAddress?: string
  /** Optional description. */
  comments?: string
  /**
   * ⚠ WRITE-ONLY secret — the IPSec pre-shared key. Present only on the way IN
   * (from the canvas). It is NEVER read back from ZIA, so it must never be
   * persisted into rollbackData, artifacts or logs.
   */
  preSharedKey?: string
}

/**
 * Shape of a VPN credential returned by GET /vpnCredentials. NOTE the absence of
 * `preSharedKey`: ZIA never returns it, so it is deliberately NOT modelled here —
 * there is nothing to read, diff or capture.
 */
export interface LiveVpnCredential {
  id?: number
  type?: string
  fqdn?: string
  ipAddress?: string
  comments?: string
}

/** Trim a value to a non-empty string, or undefined. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Preserve a secret's EXACT characters (a PSK may contain spaces or punctuation),
 * but treat a whitespace-only value as blank (undefined). The secret is required,
 * so validate rejects an undefined one — this only distinguishes "set" from
 * "blank".
 */
function optionalSecret(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : ''
  return raw.trim() ? raw : undefined
}

/** Each canvas item describes one ZIA VPN credential. */
export function extractVpnCredentialSpecs(canvas: CanvasSnapshot): VpnCredentialSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      type: typeof fields.type === 'string' ? fields.type.trim().toUpperCase() : '',
      fqdn: optionalString(fields.fqdn),
      ipAddress: optionalString(fields.ip_address),
      comments: optionalString(fields.comments),
      preSharedKey: optionalSecret(fields.pre_shared_key),
    }
  })
}

/**
 * The credential's logical identity — its fqdn (UFQDN) or ip_address (IP). '' when
 * the type or its identity field is unset. This is the key deploy / drift /
 * healthCheck reconcile on.
 */
export function credentialIdentity(spec: VpnCredentialSpec): string {
  if (spec.type === 'UFQDN') return spec.fqdn ?? ''
  if (spec.type === 'IP') return spec.ipAddress ?? ''
  return ''
}

/** The identity of a LIVE credential returned by ZIA (mirrors credentialIdentity). */
export function liveCredentialIdentity(live: LiveVpnCredential): string {
  const type = typeof live.type === 'string' ? live.type.trim().toUpperCase() : ''
  if (type === 'UFQDN') return typeof live.fqdn === 'string' ? live.fqdn : ''
  if (type === 'IP') return typeof live.ipAddress === 'string' ? live.ipAddress : ''
  // Fall back to whichever identity field is populated when type is absent.
  if (typeof live.fqdn === 'string' && live.fqdn) return live.fqdn
  if (typeof live.ipAddress === 'string' && live.ipAddress) return live.ipAddress
  return ''
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate VPN credential configurations against ZIA constraints (no network):
 *   - type is required and must be IP or UFQDN;
 *   - the identity field matching the type is required (UFQDN → fqdn, IP →
 *     ip_address);
 *   - pre_shared_key is required — a create needs it and validate cannot tell a
 *     create from an update, so the canvas must always carry it;
 *   - the identity (fqdn/ip_address) is unique across the canvas (matched
 *     case-insensitively, since a tunnel identity is case-insensitive).
 *
 * Static only — it cannot (and must not) verify the PSK value: it is write-only
 * and never returned by the API.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractVpnCredentialSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // type — required, one of IP | UFQDN.
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Credential type is required', code: 'required' })
    } else if (!(VPN_CREDENTIAL_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Credential type must be one of: ${VPN_CREDENTIAL_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // The identity field required for the chosen type.
    if (spec.type === 'UFQDN') {
      if (!spec.fqdn) {
        errors.push({ field: `${prefix}.fqdn`, message: 'FQDN is required for a UFQDN credential', code: 'required' })
      } else if (spec.fqdn.length > MAX_IDENTITY_LENGTH) {
        errors.push({
          field: `${prefix}.fqdn`,
          message: `FQDN must be ${MAX_IDENTITY_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
    } else if (spec.type === 'IP') {
      if (!spec.ipAddress) {
        errors.push({
          field: `${prefix}.ip_address`,
          message: 'IP address is required for an IP credential',
          code: 'required',
        })
      } else if (spec.ipAddress.length > MAX_IDENTITY_LENGTH) {
        errors.push({
          field: `${prefix}.ip_address`,
          message: `IP address must be ${MAX_IDENTITY_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
    }

    // ⚠ WRITE-ONLY SECRET — required (create needs it; validate can't tell
    // create from update, so it must always be present). Never inspect its value.
    if (!spec.preSharedKey) {
      errors.push({
        field: `${prefix}.pre_shared_key`,
        message: 'Pre-shared key is required',
        code: 'required',
      })
    }

    if (spec.comments && spec.comments.length > MAX_COMMENTS_LENGTH) {
      errors.push({
        field: `${prefix}.comments`,
        message: `Comments must be ${MAX_COMMENTS_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // Dedupe on the identity (fqdn/ip_address), matched case-insensitively.
    const identity = credentialIdentity(spec)
    if (identity) {
      const key = identity.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.${spec.type === 'IP' ? 'ip_address' : 'fqdn'}`,
          message: `Duplicate VPN credential "${identity}" — each identity may only be declared once per canvas`,
          code: 'duplicate_vpn_credential',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
