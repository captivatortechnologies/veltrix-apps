import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parsePositiveInt } from '../../lib/cyberark'

// =============================================================================
// CyberArk Safes — validate + shared spec extraction.
//
// A safe is a named container for privileged accounts. CyberArk assigns a
// `safeUrlId` (used in URL paths), so the logical identity for reconciliation is
// the natural key: the safe name. A safe declares exactly ONE retention policy —
// either by number of versions OR by number of days.
// =============================================================================

/** Retention is by version count or by day count — exactly one of the two. */
export const RETENTION_TYPES = ['versions', 'days'] as const
export type RetentionType = (typeof RETENTION_TYPES)[number]

export interface SafeSpec {
  sectionName: string
  safeName: string
  description: string
  location: string
  managingCpm: string
  retentionType: RetentionType
  retentionCount: number | null
  olacEnabled: boolean
  autoPurgeEnabled: boolean
}

/** Shape of a safe returned by GET /Safes. */
export interface LiveSafe {
  safeUrlId?: string
  safeName?: string
  description?: string
  location?: string
  managingCPM?: string
  numberOfDaysRetention?: number
  numberOfVersionsRetention?: number
  olacEnabled?: boolean
  autoPurgeEnabled?: boolean
  // Read-only attribution fields the Gen2 list returns per safe — used by drift
  // attribution to name the safe's creator and when it was created / modified.
  creator?: { id?: string | number; name?: string; source?: string }
  creationTime?: number
  lastModificationTime?: number
}

/** A safe's natural key — its name, normalised to lower-case for reconciliation. */
export function safeKey(spec: { safeName: string }): string {
  return spec.safeName.trim().toLowerCase()
}

function readBool(value: unknown): boolean {
  return value === true || value === 'true'
}

/** Each canvas item describes one CyberArk safe. */
export function extractSafeSpecs(canvas: CanvasSnapshot): SafeSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const retentionType =
      fields.retention_type === 'days' ? 'days' : 'versions'
    return {
      sectionName: section.name,
      safeName: typeof fields.safe_name === 'string' ? fields.safe_name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      location: typeof fields.location === 'string' ? fields.location.trim() : '',
      managingCpm: typeof fields.managing_cpm === 'string' ? fields.managing_cpm.trim() : '',
      retentionType,
      retentionCount: parsePositiveInt(fields.retention_count).value,
      olacEnabled: readBool(fields.olac_enabled),
      autoPurgeEnabled: readBool(fields.auto_purge_enabled),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate safe configurations: a name and a positive retention count are
 * required, the retention type is supported, and the safe name (its natural key)
 * is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSafeSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.safeName) {
      errors.push({ field: `${prefix}.safe_name`, message: 'Safe name is required', code: 'required' })
    } else if (spec.safeName.length > 28) {
      // CyberArk enforces a 28-character maximum on safe names.
      errors.push({
        field: `${prefix}.safe_name`,
        message: `Safe name "${spec.safeName}" exceeds the 28-character CyberArk limit`,
        code: 'safe_name_too_long',
      })
    }

    if (!RETENTION_TYPES.includes(spec.retentionType)) {
      errors.push({ field: `${prefix}.retention_type`, message: `Unsupported retention type "${spec.retentionType}"`, code: 'invalid_retention_type' })
    }

    const retention = parsePositiveInt((sections.find((s) => s.name === prefix)?.fields ?? {}).retention_count)
    if (retention.error) {
      errors.push({ field: `${prefix}.retention_count`, message: `Retention count ${retention.error}`, code: 'invalid_retention' })
    } else if (retention.value === null) {
      errors.push({ field: `${prefix}.retention_count`, message: 'Retention count is required', code: 'required' })
    }

    if (spec.safeName) {
      const key = safeKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.safe_name`,
          message: `Duplicate safe "${spec.safeName}" — each safe name may only be declared once`,
          code: 'duplicate_safe',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
