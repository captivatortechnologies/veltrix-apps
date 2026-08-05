import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault lease count quota constraints (Vault ENTERPRISE only) -------------
//
// See: https://developer.hashicorp.com/vault/api-docs/system/lease-count-quotas
// A lease count quota caps the number of LEASES a mount/namespace/role may hold
// concurrently — distinct from a rate limit quota, which caps REQUESTS per
// interval. This is an Enterprise-only feature (the endpoint 404s on Vault OSS).

/**
 * A quota name is one or more letters/digits/_/-. It becomes the last path
 * segment of /sys/quotas/lease-count/{name}, so it is the quota's identity.
 * Vault has no reserved lease-count quota name, so no name is protected here.
 */
export const QUOTA_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * A quota `path` scopes the limiter to a mount or namespace path. It may be a
 * plain API path ("secret/") or end in a `*` glob ("secret/*"). An EMPTY path is
 * the GLOBAL limiter for the whole cluster — allowed, but warned about.
 */
export const QUOTA_PATH_PATTERN = /^[A-Za-z0-9_./*-]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface LeaseCountQuotaSpec {
  sectionName: string
  /** Quota name — the limiter's identity, the {name} in /sys/quotas/lease-count/{name}. */
  name: string
  /** Scope path; "" is the GLOBAL lease-count limiter for the entire Vault. */
  path: string
  /** max_leases — REQUIRED, the maximum number of leases permitted concurrently. NaN when unset. */
  maxLeases: number
  /** role — only meaningful for a login quota on an auth mount path; usually blank. */
  role?: string
  /** inheritable — when true on a namespace path, the quota also applies to every child namespace. */
  inheritable: boolean
}

/** Shape of the quota returned by GET /sys/quotas/lease-count/{name} (under `data`). */
export interface LiveLeaseCountQuota {
  type?: string
  name?: string
  path?: string
  max_leases?: number
  role?: string
  inheritable?: boolean
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Coerce a canvas number field (which may arrive as a number or a string) to a number. */
export function toMaxLeases(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) return Number(value.trim())
  return NaN
}

/** Coerce a checkbox value to a boolean, falling back to a default when unset. */
export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() !== 'false' && value !== '0'
  return Boolean(value)
}

/** Each canvas section describes one Vault lease count quota. */
export function extractLeaseCountQuotaSpecs(canvas: CanvasSnapshot): LeaseCountQuotaSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      // An empty/blank path is the GLOBAL limiter — preserve "" (do not fold to undefined).
      path: typeof fields.path === 'string' ? fields.path.trim() : '',
      maxLeases: toMaxLeases(fields.maxLeases),
      role: optionalString(fields.role),
      inheritable: coerceBoolean(fields.inheritable, false),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate lease count quota configurations against Vault's constraints (no
 * network): a name (allowed characters, unique per canvas) and a positive whole
 * `max_leases` are required. An EMPTY path is allowed but WARNS — it is the
 * global limiter for the whole cluster, which caps concurrent leases for every
 * mount (a high-blast-radius setting).
 *
 * This is an Enterprise-only Vault feature — the endpoint does not exist on
 * Vault OSS, so deploy/healthCheck surface a clear "quotas: feature not found"
 * message rather than a confusing generic 404.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractLeaseCountQuotaSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, allowed characters, unique in canvas (it is the identity).
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Quota name is required', code: 'required' })
    } else {
      if (!QUOTA_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Quota name may contain only letters, digits, and the characters _ and -',
          code: 'invalid_name',
        })
      }
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate quota name "${spec.name}" — each lease count quota may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(spec.name)
    }

    // maxLeases — required; a positive whole number.
    if (Number.isNaN(spec.maxLeases)) {
      errors.push({
        field: `${prefix}.maxLeases`,
        message: 'Max leases is required — enter the maximum number of concurrent leases permitted (e.g. 1000)',
        code: 'required',
      })
    } else if (!Number.isInteger(spec.maxLeases) || spec.maxLeases <= 0) {
      errors.push({
        field: `${prefix}.maxLeases`,
        message: 'Max leases must be a positive whole number',
        code: 'invalid_max_leases',
      })
    }

    // path — EMPTY is allowed but is the GLOBAL limiter → WARN (never error).
    if (spec.path === '') {
      warnings.push({
        field: `${prefix}.path`,
        message:
          `Quota "${spec.name || prefix}" has an empty path — it is the GLOBAL lease count limiter for the ` +
          `entire Vault cluster, capping concurrent leases for every mount. This is a HIGH-BLAST-RADIUS ` +
          `setting; set a mount or namespace path (optionally ending in "*") to scope it.`,
        code: 'global_quota',
      })
    } else if (!QUOTA_PATH_PATTERN.test(spec.path)) {
      errors.push({
        field: `${prefix}.path`,
        message: 'Path may contain only letters, digits, and the characters _ . / - * (a trailing * is a glob)',
        code: 'invalid_path',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
