import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { splitOrderedList } from './_shared'

/**
 * Validate zone-assignment items: a non-empty unique zone name, and at least
 * one posture policy name when enabled. Static — no target access required;
 * this app cannot confirm the zone/policy names exist until deploy.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one zone assignment.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const zoneName = String(item.fields.zoneName ?? '').trim()
    const p = (field: string) => `items[${i}].${field}`

    if (!zoneName) {
      errors.push({ field: p('zoneName'), message: 'Zone Name is required.', code: 'EMPTY_ZONE_NAME' })
    } else if (seen.has(zoneName)) {
      errors.push({ field: p('zoneName'), message: `Zone "${zoneName}" is listed more than once — a zone can have only one assignment.`, code: 'DUPLICATE_ZONE' })
    } else {
      seen.add(zoneName)
    }

    const enabled = item.fields.enabled !== false
    if (enabled && splitOrderedList(item.fields.policyNames).length === 0) {
      errors.push({ field: p('policyNames'), message: 'At least one Posture Policy name is required when enabled.', code: 'EMPTY_POLICY_NAMES' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
