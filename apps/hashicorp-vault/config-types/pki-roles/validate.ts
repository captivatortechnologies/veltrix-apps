import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault PKI secrets engine ROLE constraints --------------------------------
//
// See: https://developer.hashicorp.com/vault/api-docs/secret/pki#create-update-role
// A PKI role is the certificate-ISSUANCE POLICY a `vault write pki/issue/:role`
// (or the equivalent API call) is checked against — it is pure CONFIG. The
// certificates and private keys actually ISSUED under a role are SECRET DATA:
// they are never modeled, read, or written by this config type. `POST
// {mount}/roles/{name}` is a FULL REPLACE of the role's fields (any parameter
// this canvas does not set is written using VAULT'S OWN DEFAULT, not left at
// whatever a live role currently has) — see deploy.ts.

/** A mount path may contain letters, digits and the characters _ . / - . */
export const MOUNT_PATH_PATTERN = /^[A-Za-z0-9_./-]+$/

/** A PKI role name may contain letters, digits and the characters _ . - . */
export const ROLE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

/** Key types the `key_type` parameter accepts. */
export const KEY_TYPES = ['rsa', 'ec', 'ed25519', 'any'] as const

/**
 * A Vault duration is either a plain whole number of seconds or a Go-style
 * duration made of `<number><unit>` runs (s/m/h/d), e.g. "768h", "1h30m".
 * (Kept local so this config type stays self-contained — mirrors secret-mounts.)
 */
export function isValidVaultDuration(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (/^\d+$/.test(v)) return true
  return /^(?:\d+(?:\.\d+)?(?:s|m|h|d))+$/i.test(v)
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface PkiRoleSpec {
  sectionName: string
  /** PKI secrets engine mount path (e.g. "pki", "pki_int"). Part of the identity. */
  mount: string
  /** Role name — the {name} in {mount}/roles/{name}. Part of the identity. */
  name: string

  // --- certificate policy ---
  ttl?: string
  maxTtl?: string
  keyType?: string
  keyBits?: number
  keyUsage: string[]
  notBeforeDuration?: string
  issuerRef?: string

  // --- domain constraints ---
  allowedDomains: string[]
  allowBareDomains: boolean
  allowSubdomains: boolean
  allowGlobDomains: boolean
  allowWildcardCertificates: boolean
  allowLocalhost: boolean
  allowAnyName: boolean
  enforceHostnames: boolean
  allowIpSans: boolean

  // --- usage & issuance ---
  serverFlag: boolean
  clientFlag: boolean
  codeSigningFlag: boolean
  requireCn: boolean
  useCsrCommonName: boolean
  noStore: boolean
  generateLease: boolean
}

/**
 * Shape of a role returned by GET {mount}/roles/{name} (under `data`). Vault's
 * PKI role has 30+ possible fields (including ones this canvas never sets,
 * e.g. allowed_uri_sans, policy_identifiers) — modeled loosely so a full prior
 * object can be captured for rollback without enumerating every field Vault may
 * return (see deploy.ts's PkiRoleRollbackEntry.priorBody).
 */
export type LivePkiRole = Record<string, unknown>

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Coerce a numeric field (a `number` input or text) to a number; NaN when unparseable. */
export function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const n = Number(String(value).trim())
  return Number.isNaN(n) ? NaN : n
}

/** Coerce a checkbox value to a boolean, falling back to a default when unset. */
export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() !== 'false' && value !== '0'
  return Boolean(value)
}

/** Normalize a list value — canvas `tags` fields arrive as arrays (or comma/newline text). */
export function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Trim and strip surrounding slashes so a mount reference is canonical. */
export function normalizeMountPath(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/^\/+|\/+$/g, '')
}

/** The composite role identity "mount/name" — the dedup + match key. */
export function roleKey(mount: string, name: string): string {
  return `${mount}/${name}`
}

/** Each canvas section describes one Vault PKI role. */
export function extractPkiRoleSpecs(canvas: CanvasSnapshot): PkiRoleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      mount: normalizeMountPath(fields.mount),
      name: typeof fields.name === 'string' ? fields.name.trim() : '',

      ttl: optionalString(fields.ttl),
      maxTtl: optionalString(fields.maxTtl),
      keyType: optionalString(fields.keyType)?.toLowerCase(),
      keyBits: optionalNumber(fields.keyBits),
      keyUsage: normalizeList(fields.keyUsage),
      notBeforeDuration: optionalString(fields.notBeforeDuration),
      issuerRef: optionalString(fields.issuerRef),

      allowedDomains: normalizeList(fields.allowedDomains),
      allowBareDomains: coerceBoolean(fields.allowBareDomains, false),
      allowSubdomains: coerceBoolean(fields.allowSubdomains, false),
      allowGlobDomains: coerceBoolean(fields.allowGlobDomains, false),
      allowWildcardCertificates: coerceBoolean(fields.allowWildcardCertificates, true),
      allowLocalhost: coerceBoolean(fields.allowLocalhost, true),
      allowAnyName: coerceBoolean(fields.allowAnyName, false),
      enforceHostnames: coerceBoolean(fields.enforceHostnames, true),
      allowIpSans: coerceBoolean(fields.allowIpSans, true),

      serverFlag: coerceBoolean(fields.serverFlag, true),
      clientFlag: coerceBoolean(fields.clientFlag, true),
      codeSigningFlag: coerceBoolean(fields.codeSigningFlag, false),
      requireCn: coerceBoolean(fields.requireCn, true),
      useCsrCommonName: coerceBoolean(fields.useCsrCommonName, true),
      noStore: coerceBoolean(fields.noStore, false),
      generateLease: coerceBoolean(fields.generateLease, false),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate PKI role configurations against Vault's constraints (no network): a
 * mount and a name are required (both URL-safe), the composite (mount, name) —
 * the role's identity — is unique per canvas, keyType/keyBits/ttl/maxTtl/
 * notBeforeDuration are well-formed when set. Booleans always have a value
 * (they default from Vault's own documented defaults on extraction).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPkiRoleSpecs(ctx.canvas)
  const seenKeys = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // mount — required, URL-safe charset
    if (!spec.mount) {
      errors.push({ field: `${prefix}.mount`, message: 'PKI mount path is required (e.g. "pki")', code: 'required' })
    } else if (!MOUNT_PATH_PATTERN.test(spec.mount)) {
      errors.push({
        field: `${prefix}.mount`,
        message: 'Mount path may contain only letters, digits, and the characters _ . / -',
        code: 'invalid_mount',
      })
    }

    // name — required, safe charset
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required', code: 'required' })
    } else if (!ROLE_NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Role name may contain only letters, digits, and the characters _ . -',
        code: 'invalid_name',
      })
    }

    // (mount, name) is the role's identity — dedupe on the composite key.
    if (spec.mount && spec.name) {
      const key = roleKey(spec.mount, spec.name)
      if (seenKeys.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate PKI role "${key}" — each (mount, name) role may only be declared once per canvas`,
          code: 'duplicate_role',
        })
      }
      seenKeys.add(key)
    }

    // keyType — optional; one of the known values
    if (spec.keyType !== undefined && !(KEY_TYPES as readonly string[]).includes(spec.keyType)) {
      errors.push({
        field: `${prefix}.keyType`,
        message: `Key type must be one of ${KEY_TYPES.join(', ')}`,
        code: 'invalid_key_type',
      })
    }

    // keyBits — optional; a positive whole number
    if (spec.keyBits !== undefined && (Number.isNaN(spec.keyBits) || !Number.isInteger(spec.keyBits) || spec.keyBits <= 0)) {
      errors.push({ field: `${prefix}.keyBits`, message: 'Key bits must be a positive whole number', code: 'invalid_key_bits' })
    }

    // ttl / maxTtl / notBeforeDuration — optional Vault durations
    if (spec.ttl !== undefined && !isValidVaultDuration(spec.ttl)) {
      errors.push({ field: `${prefix}.ttl`, message: 'TTL must be a Vault duration (e.g. "720h") or a whole number of seconds', code: 'invalid_ttl' })
    }
    if (spec.maxTtl !== undefined && !isValidVaultDuration(spec.maxTtl)) {
      errors.push({ field: `${prefix}.maxTtl`, message: 'Max TTL must be a Vault duration (e.g. "8760h") or a whole number of seconds', code: 'invalid_ttl' })
    }
    if (spec.notBeforeDuration !== undefined && !isValidVaultDuration(spec.notBeforeDuration)) {
      errors.push({
        field: `${prefix}.notBeforeDuration`,
        message: 'Not-before duration must be a Vault duration (e.g. "30s") or a whole number of seconds',
        code: 'invalid_duration',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
