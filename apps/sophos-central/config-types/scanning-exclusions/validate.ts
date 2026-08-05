import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SOPHOS_SCANNING_EXCLUSION_TYPES, SOPHOS_SCAN_MODES } from '../../lib/sophosApi'
import { extractScanningExclusionSpecs, scanningExclusionKey } from './_shared'

/** Types whose scan mode Sophos does not accept, per the documented request schema. */
const NO_SCAN_MODE_TYPES = new Set(['behavioral', 'detectedExploit'])

/**
 * Validate scanning exclusion(s): a known `type`, a required `value`, an
 * optional `scanMode` restricted to the documented enum (and flagged when set
 * for a type that doesn't support one), and uniqueness per (type, value).
 * Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scanning exclusion.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScanningExclusionSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Exclusion type is required.', code: 'REQUIRED' })
    } else if (!(SOPHOS_SCANNING_EXCLUSION_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `"${spec.type}" must be one of ${SOPHOS_SCANNING_EXCLUSION_TYPES.join(', ')}.`,
        code: 'INVALID_TYPE',
      })
    }

    if (!spec.value) {
      errors.push({ field: `${prefix}.value`, message: 'Value is required.', code: 'REQUIRED' })
    }

    if (spec.scanMode) {
      if (!(SOPHOS_SCAN_MODES as readonly string[]).includes(spec.scanMode)) {
        errors.push({
          field: `${prefix}.scanMode`,
          message: `"${spec.scanMode}" must be one of ${SOPHOS_SCAN_MODES.join(', ')}.`,
          code: 'INVALID_SCAN_MODE',
        })
      } else if (NO_SCAN_MODE_TYPES.has(spec.type)) {
        warnings.push({
          field: `${prefix}.scanMode`,
          message: `Scan mode is ignored for "${spec.type}" exclusions — Sophos does not support a scan mode for this type.`,
          code: 'SCAN_MODE_NOT_SUPPORTED',
        })
      }
    }

    if (spec.type && spec.value) {
      const key = scanningExclusionKey(spec.type, spec.value)
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.value`,
          message: `"${spec.value}" (type "${spec.type}") is listed more than once; the last one wins.`,
          code: 'DUPLICATE_EXCLUSION',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
