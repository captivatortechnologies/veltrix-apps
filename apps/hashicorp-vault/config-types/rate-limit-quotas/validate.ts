import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault rate limit quota constraints --------------------------------------

/**
 * A rate limit quota name is one or more letters/digits/_/-. It becomes the last
 * path segment of /sys/quotas/rate-limit/{name}, so it is the quota's identity.
 * Vault OSS has NO reserved quota name (the "default" name is not special here),
 * so this type keeps no protected-name denylist.
 */
export const QUOTA_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * A quota `path` scopes the limiter to a mount or namespace path. It may be a
 * plain API path ("secret/data/app") or end in a `*` glob ("secret/*"). An EMPTY
 * path is the GLOBAL limiter for the whole cluster — allowed, but warned about.
 */
export const QUOTA_PATH_PATTERN = /^[A-Za-z0-9_./*-]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface QuotaSpec {
  sectionName: string
  /** Quota name — the limiter's identity, the {name} in /sys/quotas/rate-limit/{name}. */
  name: string
  /** Scope path; "" is the GLOBAL rate limiter for the entire Vault (high blast radius). */
  path: string
  /** rate — REQUIRED, requests permitted per interval; a positive float. NaN when unset. */
  rate: number
  /** interval — a Vault duration ("1s"); absent leaves the Vault default. */
  interval?: string
  /** block_interval — a Vault duration ("0s"); how long to block once the rate trips. */
  blockInterval?: string
  /** role — only meaningful for a login quota on an auth mount path; usually blank. */
  role?: string
}

/** Shape of the quota returned by GET /sys/quotas/rate-limit/{name} (under `data`). */
export interface LiveQuota {
  type?: string
  name?: string
  path?: string
  rate?: number
  /** Vault echoes interval / block_interval as a whole number of SECONDS. */
  interval?: number
  block_interval?: number
  role?: string
}

/**
 * A Vault duration is either a plain whole number of seconds or a Go-style
 * duration made of `<number><unit>` runs (s/m/h/d), e.g. "1s", "0s", "1h30m".
 * (Kept local so this config type stays self-contained — mirrors the mount one.)
 */
export function isValidVaultDuration(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (/^\d+$/.test(v)) return true
  return /^(?:\d+(?:\.\d+)?(?:s|m|h|d))+$/i.test(v)
}

/**
 * Parse a Vault duration to seconds, or undefined when it cannot be parsed. A
 * plain integer is treated as seconds; otherwise the s/m/h/d units are summed.
 * Shared with driftDetect so canvas intervals and live (seconds) values compare.
 */
export function parseDurationSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const v = value.trim()
  if (!v) return undefined
  if (/^\d+$/.test(v)) return Number(v)
  const re = /(\d+(?:\.\d+)?)(s|m|h|d)/gi
  let total = 0
  let matched = false
  let m: RegExpExecArray | null
  while ((m = re.exec(v)) !== null) {
    matched = true
    const n = parseFloat(m[1])
    const unit = m[2].toLowerCase()
    total += unit === 'd' ? n * 86400 : unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n
  }
  return matched ? total : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Coerce a canvas number field (which may arrive as a number or a string) to a number. */
export function toRate(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) return Number(value.trim())
  return NaN
}

/** Each canvas section describes one Vault rate limit quota. */
export function extractQuotaSpecs(canvas: CanvasSnapshot): QuotaSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      // An empty/blank path is the GLOBAL limiter — preserve "" (do not fold to undefined).
      path: typeof fields.path === 'string' ? fields.path.trim() : '',
      rate: toRate(fields.rate),
      interval: optionalString(fields.interval),
      blockInterval: optionalString(fields.blockInterval),
      role: optionalString(fields.role),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate rate limit quota configurations against Vault's constraints (no
 * network): a name (allowed characters, unique per canvas) and a positive `rate`
 * are required; any interval / block_interval is a Vault duration. An EMPTY path
 * is allowed but WARNS — it is the global limiter for the whole cluster, which
 * throttles every request to Vault (a high-blast-radius setting).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractQuotaSpecs(ctx.canvas)
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
          message: `Duplicate quota name "${spec.name}" — each rate limit quota may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(spec.name)
    }

    // rate — required; a positive float (requests per interval).
    if (Number.isNaN(spec.rate)) {
      errors.push({
        field: `${prefix}.rate`,
        message: 'Rate is required — enter the number of requests permitted per interval (e.g. 1000)',
        code: 'required',
      })
    } else if (!Number.isFinite(spec.rate) || spec.rate <= 0) {
      errors.push({
        field: `${prefix}.rate`,
        message: 'Rate must be a positive number (requests per interval), at least 0.0001',
        code: 'invalid_rate',
      })
    }

    // path — EMPTY is allowed but is the GLOBAL limiter → WARN (never error).
    if (spec.path === '') {
      warnings.push({
        field: `${prefix}.path`,
        message:
          `Quota "${spec.name || prefix}" has an empty path — it is the GLOBAL rate limiter for the entire ` +
          `Vault cluster, so every request counts against it. This is a HIGH-BLAST-RADIUS setting; set a ` +
          `mount or namespace path (optionally ending in "*") to scope it.`,
        code: 'global_quota',
      })
    } else if (!QUOTA_PATH_PATTERN.test(spec.path)) {
      errors.push({
        field: `${prefix}.path`,
        message: 'Path may contain only letters, digits, and the characters _ . / - * (a trailing * is a glob)',
        code: 'invalid_path',
      })
    }

    // interval / block_interval — optional; when present each is a Vault duration.
    if (spec.interval !== undefined && !isValidVaultDuration(spec.interval)) {
      errors.push({
        field: `${prefix}.interval`,
        message: 'Interval must be a Vault duration (e.g. "1s", "1m") or a whole number of seconds',
        code: 'invalid_interval',
      })
    }
    if (spec.blockInterval !== undefined && !isValidVaultDuration(spec.blockInterval)) {
      errors.push({
        field: `${prefix}.blockInterval`,
        message: 'Block interval must be a Vault duration (e.g. "0s", "30s") or a whole number of seconds',
        code: 'invalid_block_interval',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
