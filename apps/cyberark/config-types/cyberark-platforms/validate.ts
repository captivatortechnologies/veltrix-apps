import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { isLikelyBase64 } from '../../lib/cyberark'

// =============================================================================
// CyberArk Platforms — validate + shared spec extraction.
//
// A target platform is identified by its PlatformID (a stable string such as
// WinServerLocal). CyberArk also assigns a numeric `ID` (used to activate /
// deactivate / delete), so the logical identity for reconciliation is the natural
// key: the PlatformID. This type manages a platform's PRESENCE (imported from a
// BASE 64 package when missing) and its ACTIVE state.
//
// ⚠ WRITE-ONLY PACKAGE. Each item may carry an `import_package` (a BASE 64
// platform .zip). CyberArk NEVER returns it on read. This app therefore sends it
// ONLY when CREATING (importing) a missing platform; it is never read back,
// diffed, or stored in rollbackData / artifacts / logs. This module only checks
// that, when present, it is well-formed BASE 64 — it never decodes its value.
// =============================================================================

export interface PlatformSpec {
  sectionName: string
  platformId: string
  active: boolean
  /** ⚠ Write-only BASE 64 package. Sent only on import; never read/diffed/stored. */
  importPackage: string
}

/** Shape of a target platform returned by GET /Platforms/Targets. */
export interface LivePlatform {
  ID?: number
  PlatformID?: string
  Name?: string
  Active?: boolean
  SystemType?: string
  AllowedSafes?: string
}

/** A platform's natural key — its PlatformID, lower-cased for reconciliation. */
export function platformKey(spec: { platformId: string }): string {
  return spec.platformId.trim().toLowerCase()
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

/** Each canvas item describes one CyberArk target platform. */
export function extractPlatformSpecs(canvas: CanvasSnapshot): PlatformSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      platformId: typeof fields.platform_id === 'string' ? fields.platform_id.trim() : '',
      active: readBool(fields.active, true),
      // Only surrounding whitespace is trimmed; the value is never logged or surfaced.
      importPackage: typeof fields.import_package === 'string' ? fields.import_package.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate platform configurations: a PlatformID (≤ 99 chars) is required and
 * unique across the canvas, and any supplied import package must be well-formed
 * BASE 64. The package is write-only and is never inspected beyond that check.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPlatformSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.platformId) {
      errors.push({ field: `${prefix}.platform_id`, message: 'Platform ID is required', code: 'required' })
    } else if (spec.platformId.length > 99) {
      errors.push({
        field: `${prefix}.platform_id`,
        message: `Platform ID "${spec.platformId}" exceeds the 99-character CyberArk limit`,
        code: 'platform_id_too_long',
      })
    }

    if (spec.importPackage && !isLikelyBase64(spec.importPackage)) {
      errors.push({
        field: `${prefix}.import_package`,
        message: 'Platform package must be a BASE 64-encoded .zip',
        code: 'invalid_package',
      })
    }

    if (spec.platformId) {
      const key = platformKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.platform_id`,
          message: `Duplicate platform "${spec.platformId}" — each Platform ID may only be declared once`,
          code: 'duplicate_platform',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
