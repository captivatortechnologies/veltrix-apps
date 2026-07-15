import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SentinelOne hash-allowlist constraints ----------------------------------

export const OS_TYPES = ['windows', 'windows_legacy', 'linux', 'macos'] as const

const HEX = /^[0-9a-fA-F]+$/
const SHA1_LENGTH = 40
const SHA256_LENGTH = 64

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface HashSpec {
  sectionName: string
  sha1: string
  sha256?: string
  osType: string
  description?: string
}

/** Shape of a hash restriction returned by GET /restrictions (type white_hash). */
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
 * The (SHA1, osType) natural key — an allowlisted hash's logical identity at a
 * scope. Hashes are case-insensitive, so the SHA1 is lower-cased for matching.
 */
export function hashKey(spec: { sha1: string; osType: string }): string {
  return JSON.stringify([spec.sha1.toLowerCase(), spec.osType])
}

/** Each canvas item describes one SentinelOne allowlisted hash. */
export function extractHashSpecs(canvas: CanvasSnapshot): HashSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const sha256 =
      typeof fields.sha256 === 'string' && fields.sha256.trim() ? fields.sha256.trim() : undefined
    const description =
      typeof fields.description === 'string' && fields.description.trim() ? fields.description.trim() : undefined
    return {
      sectionName: section.name,
      sha1: typeof fields.sha1 === 'string' ? fields.sha1.trim() : '',
      sha256,
      osType: typeof fields.os_type === 'string' ? fields.os_type.trim() : '',
      description,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate allowlisted-hash configurations against SentinelOne constraints: a
 * SHA1 and an OS are required, the OS is from the supported set, and the
 * (SHA1, osType) natural key must be unique across the canvas. A SHA1 that is not
 * a 40-character hex string (or a SHA256 that is not 64 hex chars) is warned about
 * rather than rejected — SentinelOne is the source of truth on hash format.
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
    } else if (!HEX.test(spec.sha1) || spec.sha1.length !== SHA1_LENGTH) {
      warnings.push({
        field: `${prefix}.sha1`,
        message: `SHA1 "${spec.sha1}" is not a 40-character hex hash`,
        code: 'hash_format',
      })
    }

    if (spec.sha256 && (!HEX.test(spec.sha256) || spec.sha256.length !== SHA256_LENGTH)) {
      warnings.push({
        field: `${prefix}.sha256`,
        message: `SHA256 "${spec.sha256}" is not a 64-character hex hash`,
        code: 'hash_format',
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
          message: `Duplicate hash "${spec.sha1} (${spec.osType})" — each (hash, OS) may only be declared once`,
          code: 'duplicate_hash',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
