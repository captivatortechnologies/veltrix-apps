import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk SAST (Snyk Code) settings — a SINGLETON org setting.
//
// The org has exactly one SAST settings object; REST exposes it at
// GET/PATCH /orgs/{org_id}/settings/sast with attribute { sast_enabled }.
// The canvas therefore carries exactly one (non-repeatable) item.
// =============================================================================

export interface SastSettingsSpec {
  sectionName: string
  sastEnabled: boolean
}

/** The JSON:API attributes of the SAST settings object. */
export interface LiveSastSettings {
  sast_enabled?: boolean
}

/** Read a checkbox/boolean-ish field, falling back to `fallback` when unset. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'true' || t === 'yes' || t === '1') return true
    if (t === 'false' || t === 'no' || t === '0' || t === '') return false
  }
  return fallback
}

/** A SAST settings canvas holds a single item. Extract it (or a disabled default). */
export function extractSastSettings(canvas: CanvasSnapshot): SastSettingsSpec {
  const section = (canvas.sections ?? [])[0]
  const fields = section?.fields ?? {}
  return {
    sectionName: section?.name ?? 'SAST Settings',
    sastEnabled: readBool(fields.sast_enabled, false),
  }
}

/**
 * Validate SAST settings: exactly one item is expected (it is a singleton org
 * setting). Warn when Snyk Code is being turned off, since that stops all SAST
 * scanning for the org.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no SAST settings item', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({
      field: 'sections',
      message: 'SAST settings is a single org-wide setting — declare only one item',
      code: 'singleton_only',
    })
  }

  const spec = extractSastSettings(ctx.canvas)
  if (!spec.sastEnabled) {
    warnings.push({
      field: `${spec.sectionName}.sast_enabled`,
      message: 'Snyk Code (SAST) will be DISABLED for this organization — no SAST scans will run',
      code: 'sast_disabled',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
