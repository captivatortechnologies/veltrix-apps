import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SentinelOne blocklist-hash constraints ----------------------------------

/** The SentinelOne restriction type this config type manages (/restrictions). */
export const RESTRICTION_TYPE = 'black_hash'

export const OS_TYPES = ['windows', 'windows_legacy', 'linux', 'macos'] as const

const SHA1_HEX = /^[0-9a-f]{40}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface HashSpec {
  sectionName: string
  sha1: string
  sha256: string
  osType: string
  description?: string
}

/** Shape of a restriction returned by GET /restrictions. */
export interface LiveRestriction {
  id?: string
  value?: string
  sha256Value?: string
  osType?: string
  type?: string
  description?: string
  source?: string
}

/**
 * The (sha1, osType) natural key — a blocklist hash's logical identity at a
 * scope. SHA1 is hex and case-insensitive, so it is lower-cased before keying so
 * a canvas value and a live restriction value compare equal regardless of case.
 */
export function hashKey(spec: { sha1: string; osType: string }): string {
  return JSON.stringify([spec.sha1.toLowerCase(), spec.osType])
}

/** Each canvas item describes one SentinelOne blocklist hash. */
export function extractHashSpecs(canvas: CanvasSnapshot): HashSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim() ? fields.description.trim() : undefined
    return {
      sectionName: section.name,
      sha1: typeof fields.sha1 === 'string' ? fields.sha1.trim().toLowerCase() : '',
      sha256: typeof fields.sha256 === 'string' ? fields.sha256.trim().toLowerCase() : '',
      osType: typeof fields.os_type === 'string' ? fields.os_type.trim() : '',
      description,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate blocklist-hash configurations against SentinelOne constraints: SHA1
 * and OS are required (SHA1 is warned when it is not 40-char hex, SHA256 when it
 * is present but not 64-char hex); OS must be from the supported set; and the
 * (sha1, osType) natural key must be unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractHashSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.sha1) {
      errors.push({ field: `${prefix}.sha1`, message: 'SHA1 hash is required', code: 'required' })
    } else if (!SHA1_HEX.test(spec.sha1)) {
      warnings.push({
        field: `${prefix}.sha1`,
        message: `SHA1 "${spec.sha1}" is not a 40-character hex string — SentinelOne may reject it`,
        code: 'sha1_format',
      })
    }

    if (spec.sha256 && !SHA256_HEX.test(spec.sha256)) {
      warnings.push({
        field: `${prefix}.sha256`,
        message: `SHA256 "${spec.sha256}" is not a 64-character hex string`,
        code: 'sha256_format',
      })
    }

    if (!spec.osType) {
      errors.push({ field: `${prefix}.os_type`, message: 'OS is required', code: 'required' })
    } else if (!OS_TYPES.includes(spec.osType as (typeof OS_TYPES)[number])) {
      errors.push({ field: `${prefix}.os_type`, message: `Unsupported OS "${spec.osType}"`, code: 'invalid_os' })
    }

    if (spec.sha1 && spec.osType) {
      const key = hashKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.sha1`,
          message: `Duplicate blocklist hash "${spec.sha1} (${spec.osType})" — each (SHA1, OS) may only be declared once`,
          code: 'duplicate_hash',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
