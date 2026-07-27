import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'

// --- Falcon Cloud Security Registry Connection API constraints ----------------
//
// Registry connections live on the container-security collection:
//   GET    /container-security/queries/registries/v1        (list ids — limit/offset/sort, NO filter)
//   GET    /container-security/entities/registries/v1?ids=… (read full entities)
//   POST   /container-security/entities/registries/v1       (create)
//   PATCH  /container-security/entities/registries/v1?id=…  (update — PATCH, not PUT)
//   DELETE /container-security/entities/registries/v1?ids=… (delete)
//
// A registry entity carries: type, url, url_uniqueness_key, user_defined_alias
// (the display name / logical identity), state, and credential.details
// (username + password/token). The username/password are SECRETS: they are sent
// on create/update, NEVER logged, NEVER stored in rollbackData/artifacts, and
// NEVER compared in drift.
//
// ⚠ Scan settings (enabled/scanInterval) and the state/type enums are not
// enumerated by the published SDK payload builder; they are applied and diffed
// best-effort (see deploy.ts / driftDetect.ts) and should be confirmed against a
// live tenant.

/** Registry provider types (best-effort set — confirm against the Falcon console). */
export const REGISTRY_TYPES = [
  'dockerhub',
  'ecr',
  'acr',
  'gcr',
  'gar',
  'harbor',
  'artifactory',
  'quay',
  'github',
  'gitlab',
  'nexus',
  'oracle',
  'ibmcloud',
  'mirror',
  'openshift',
  'sonatype',
] as const
export type RegistryType = (typeof REGISTRY_TYPES)[number]

/** Registry state applied for enabled/disabled (best-effort — see deploy.ts). */
export const REGISTRY_STATE_ENABLED = 'active'
export const REGISTRY_STATE_DISABLED = 'paused'

export const MAX_SCAN_INTERVAL_HOURS = 168

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RegistrySpec {
  sectionName: string
  name: string
  url: string
  type: string
  /** Non-secret credential username. */
  username?: string
  /** ⚠ SECRET — the password/token. Never logged, stored, or diffed. */
  credential: string
  scanInterval?: number
  /** The raw scan-interval canvas value (trimmed) — lets validate distinguish
   * a blank field from a provided-but-unparseable one. */
  scanIntervalRaw?: string
  enabled: boolean
}

/**
 * Shape of a registry returned by GET …/registries/v1. Only NON-SECRET fields
 * are read; the credential is intentionally not modeled for reading back.
 */
export interface LiveRegistry {
  id?: string
  uuid?: string
  type?: string
  url?: string
  user_defined_alias?: string
  url_uniqueness_key?: string
  state?: string
  scan_interval?: number
  /** Last modifier recorded by Falcon — used for drift attribution (best-effort). */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** Parse a scan-interval canvas value (hours) into a positive integer, or undefined. */
export function parseScanInterval(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Each canvas section describes one registry connection. */
export function extractRegistrySpecs(canvas: CanvasSnapshot): RegistrySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      url: typeof fields.url === 'string' ? fields.url.trim() : '',
      type: typeof fields.type === 'string' ? fields.type.trim().toLowerCase() : '',
      username:
        typeof fields.username === 'string' && fields.username.trim()
          ? fields.username.trim()
          : undefined,
      // The secret is kept verbatim (not normalized) and never surfaced anywhere
      // except the create/update request body.
      credential: typeof fields.credential === 'string' ? fields.credential : '',
      scanInterval: parseScanInterval(fields.scanInterval),
      scanIntervalRaw:
        typeof fields.scanInterval === 'string' && fields.scanInterval.trim()
          ? fields.scanInterval.trim()
          : typeof fields.scanInterval === 'number'
            ? String(fields.scanInterval)
            : undefined,
      enabled: coerceBoolean(fields.enabled, true),
    }
  })
}

/** True when the spec carries a non-empty secret (whitespace-only counts as none). */
export function hasCredential(spec: RegistrySpec): boolean {
  return spec.credential.trim().length > 0
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate registry connection configurations against the API constraints:
 * name, url and type are required; type must be a known provider; the scan
 * interval, when set, must be a positive integer within range.
 *
 * The secret is never validated for content and never echoed in any message.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRegistrySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — the logical identity (user_defined_alias)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Registry name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate registry "${spec.name}" — each registry may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // url
    if (!spec.url) {
      errors.push({ field: `${prefix}.url`, message: 'Registry URL is required', code: 'required' })
    } else if (/\s/.test(spec.url)) {
      errors.push({
        field: `${prefix}.url`,
        message: 'Registry URL must not contain whitespace',
        code: 'invalid_url',
      })
    } else if (!/[.:]/.test(spec.url)) {
      errors.push({
        field: `${prefix}.url`,
        message: 'Registry URL must be a host, e.g. docker.io or 1234.dkr.ecr.us-east-1.amazonaws.com',
        code: 'invalid_url',
      })
    }

    // type
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Registry type is required', code: 'required' })
    } else if (!(REGISTRY_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Registry type must be one of: ${REGISTRY_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // scan interval — a provided-but-unparseable value is an error, not a silent blank
    if (spec.scanIntervalRaw !== undefined && spec.scanInterval === undefined) {
      errors.push({
        field: `${prefix}.scanInterval`,
        message: 'Scan interval must be a positive whole number of hours',
        code: 'invalid_scan_interval',
      })
    } else if (spec.scanInterval !== undefined) {
      if (!Number.isInteger(spec.scanInterval) || spec.scanInterval <= 0) {
        errors.push({
          field: `${prefix}.scanInterval`,
          message: 'Scan interval must be a positive whole number of hours',
          code: 'invalid_scan_interval',
        })
      } else if (spec.scanInterval > MAX_SCAN_INTERVAL_HOURS) {
        errors.push({
          field: `${prefix}.scanInterval`,
          message: `Scan interval must be ${MAX_SCAN_INTERVAL_HOURS} hours (7 days) or fewer`,
          code: 'invalid_scan_interval',
        })
      }
    }

    // credential — advisory: a new registry with no credential cannot authenticate
    if (!hasCredential(spec) && !spec.username) {
      warnings.push({
        field: `${prefix}.credential`,
        message:
          'No credential supplied — a new registry connection will be created without authentication and may fail to scan',
        code: 'no_credential',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
