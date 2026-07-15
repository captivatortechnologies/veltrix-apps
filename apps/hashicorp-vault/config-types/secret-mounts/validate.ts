import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault secret engine (mount) constraints ---------------------------------

/**
 * Vault's built-in mounts. These are reserved by the system and must never be
 * managed as code — a normal secret engine can neither be enabled at one of
 * these paths nor under it, and disabling one would break the cluster.
 */
export const PROTECTED_MOUNT_PATHS = ['sys', 'identity', 'cubbyhole'] as const

/** A mount path is one or more `/`-separated segments of letters/digits/_/-/. */
export const MOUNT_PATH_PATTERN = /^[A-Za-z0-9_./-]+$/

/** KV is the only engine whose storage behaviour is versioned (v1 vs v2). */
export const KV_ENGINE_TYPE = 'kv'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface MountSpec {
  sectionName: string
  /** Mount path — the engine's identity, e.g. "secret" or "kv/prod" (no surrounding slashes). */
  path: string
  /** Secret engine type — IMMUTABLE once mounted, e.g. kv/pki/transit/database/aws. */
  type: string
  description?: string
  /** KV store version ("1" | "2"); only meaningful when type === "kv". Set at enable time only. */
  kvVersion?: string
  /** default_lease_ttl — a Vault duration ("768h") or seconds; absent = system default. */
  defaultLeaseTtl?: string
  /** max_lease_ttl — a Vault duration or seconds; absent = system default. */
  maxLeaseTtl?: string
}

/** Shape of a mount entry returned by GET /sys/mounts (keyed by "<path>/"). */
export interface LiveMount {
  type?: string
  description?: string
  options?: Record<string, unknown> | null
  config?: Record<string, unknown> | null
  accessor?: string
}

/** Shape of the tuning returned by GET /sys/mounts/{path}/tune. */
export interface LiveMountTune {
  default_lease_ttl?: number | string
  max_lease_ttl?: number | string
  force_no_cache?: boolean
  description?: string
}

/**
 * Normalize a user-entered mount path to Vault's canonical form: no surrounding
 * slashes, inner runs of slashes collapsed. GET /sys/mounts keys entries as
 * "<path>/", so callers add the trailing slash only when matching that map.
 */
export function normalizeMountPath(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
}

/** True when a path targets (or sits under) one of Vault's reserved built-in mounts. */
export function isProtectedMountPath(path: string): boolean {
  const p = path.toLowerCase()
  return PROTECTED_MOUNT_PATHS.some((reserved) => p === reserved || p.startsWith(`${reserved}/`))
}

/**
 * A Vault duration is either a plain whole number of seconds or a Go-style
 * duration made of `<number><unit>` runs (s/m/h/d), e.g. "768h", "1h30m".
 */
export function isValidVaultDuration(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (/^\d+$/.test(v)) return true
  return /^(?:\d+(?:\.\d+)?(?:s|m|h|d))+$/i.test(v)
}

/**
 * Parse a Vault duration to seconds, or undefined when it cannot be parsed.
 * A plain integer is treated as seconds; otherwise the s/m/h/d units are summed.
 * Shared with driftDetect so canvas TTLs and live (seconds) TTLs compare cleanly.
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

/** Each canvas section describes one Vault secret engine mount. */
export function extractMountSpecs(canvas: CanvasSnapshot): MountSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      path: normalizeMountPath(fields.path),
      // Engine types are lower-case in Vault; fold input so comparisons hold.
      type: typeof fields.type === 'string' ? fields.type.trim().toLowerCase() : '',
      description: optionalString(fields.description),
      kvVersion: optionalString(fields.kvVersion),
      defaultLeaseTtl: optionalString(fields.defaultLeaseTtl),
      maxLeaseTtl: optionalString(fields.maxLeaseTtl),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate secret engine configurations against Vault's mount constraints (no
 * network): a path (allowed characters, not a reserved built-in) and a type are
 * required, any KV version is "1"/"2" and only meaningful for kv, any lease TTL
 * is a Vault duration, and the path — a mount's identity — is unique per canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractMountSpecs(ctx.canvas)
  const seenPaths = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // path — required, allowed characters, not a reserved mount, unique in canvas
    if (!spec.path) {
      errors.push({ field: `${prefix}.path`, message: 'Mount path is required', code: 'required' })
    } else {
      if (!MOUNT_PATH_PATTERN.test(spec.path)) {
        errors.push({
          field: `${prefix}.path`,
          message: 'Mount path may contain only letters, digits, and the characters _ . / -',
          code: 'invalid_path',
        })
      }
      // sys/, identity/ and cubbyhole/ are built-in Vault mounts — refuse them
      // outright so deploy never enables over, or tunes/disables, a reserved mount.
      if (isProtectedMountPath(spec.path)) {
        errors.push({
          field: `${prefix}.path`,
          message: `Mount path "${spec.path}" is reserved — sys/, identity/ and cubbyhole/ are built-in Vault mounts and cannot be managed as code`,
          code: 'protected_path',
        })
      }
      // The path is the mount's logical identity — dedupe on it (matched exactly,
      // so the dedup key equals the create-vs-tune match key in deploy).
      if (seenPaths.has(spec.path)) {
        errors.push({
          field: `${prefix}.path`,
          message: `Duplicate mount path "${spec.path}" — each secret engine path may only be declared once per canvas`,
          code: 'duplicate_path',
        })
      }
      seenPaths.add(spec.path)
    }

    // type — required; immutable once mounted
    if (!spec.type) {
      errors.push({
        field: `${prefix}.type`,
        message: 'Secret engine type is required (e.g. kv, pki, transit, database, aws)',
        code: 'required',
      })
    }

    // kvVersion — "1" or "2"; only meaningful for the kv engine
    if (spec.kvVersion !== undefined) {
      if (spec.kvVersion !== '1' && spec.kvVersion !== '2') {
        errors.push({
          field: `${prefix}.kvVersion`,
          message: 'KV version must be "1" or "2"',
          code: 'invalid_kv_version',
        })
      }
      if (spec.type && spec.type !== KV_ENGINE_TYPE) {
        warnings.push({
          field: `${prefix}.kvVersion`,
          message: `KV version is only meaningful for the "kv" engine — it is ignored for a "${spec.type}" mount`,
          code: 'kv_version_ignored',
        })
      }
    }

    // ttls — optional; when present each must be a valid Vault duration
    if (spec.defaultLeaseTtl !== undefined && !isValidVaultDuration(spec.defaultLeaseTtl)) {
      errors.push({
        field: `${prefix}.defaultLeaseTtl`,
        message: 'Default lease TTL must be a Vault duration (e.g. "768h", "30m") or a whole number of seconds',
        code: 'invalid_ttl',
      })
    }
    if (spec.maxLeaseTtl !== undefined && !isValidVaultDuration(spec.maxLeaseTtl)) {
      errors.push({
        field: `${prefix}.maxLeaseTtl`,
        message: 'Max lease TTL must be a Vault duration (e.g. "768h", "30m") or a whole number of seconds',
        code: 'invalid_ttl',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
