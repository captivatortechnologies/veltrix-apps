import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { buildFrequencies, hasAnyTier, normalizeName, toInt, TIERS } from './_shared'

/**
 * Validate SLA Domain items: a non-empty, unique name and at least one configured
 * snapshot tier (a tier needs both a positive frequency AND retention). Static —
 * no target access required. The name is the SLA Domain's identity, so a
 * duplicate name is an error (Rubrik would collide on create).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one SLA Domain.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = normalizeName(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'SLA Domain name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      errors.push({ field: `items[${i}].name`, message: `SLA Domain name "${name}" is listed more than once.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    // A tier counts only when frequency AND retention are both positive; flag a
    // half-configured tier (one set, the other zero) so it isn't silently dropped.
    for (const tier of TIERS) {
      const freq = toInt(item.fields[`${tier}Frequency`])
      const ret = toInt(item.fields[`${tier}Retention`])
      if ((freq > 0) !== (ret > 0)) {
        warnings.push({
          field: `items[${i}].${tier}`,
          message: `The ${tier} tier has a ${freq > 0 ? 'frequency but no retention' : 'retention but no frequency'} — it will be ignored. Set both or clear both.`,
          code: 'PARTIAL_TIER',
        })
      }
    }

    const frequencies = buildFrequencies(item.fields)
    if (!hasAnyTier(frequencies)) {
      errors.push({
        field: `items[${i}].frequencies`,
        message: `SLA Domain "${name || i}" has no snapshot tier — configure at least one of hourly, daily, weekly or monthly (both frequency and retention).`,
        code: 'NO_TIER',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
