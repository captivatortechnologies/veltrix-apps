import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { UUID_PATTERN } from './_shared'

/**
 * Validate authentik Brand items: a non-empty domain (the upsert identity),
 * and valid-UUID flow references when set. Static (no target access). A
 * duplicate domain is flagged (last one wins); at most one item should set
 * `default` (authentik itself does not enforce a single default, but two
 * defaults make behavior ambiguous, so this is a warning, not an error).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one brand.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  let defaultCount = 0
  items.forEach((item, i) => {
    const domain = String(item.fields.domain ?? '').trim()
    const isDefault = item.fields.default === true

    if (!domain) {
      errors.push({ field: `items[${i}].domain`, message: 'Domain is required.', code: 'EMPTY_DOMAIN' })
    } else if (seen.has(domain)) {
      warnings.push({ field: `items[${i}].domain`, message: `Domain "${domain}" is listed more than once; the last one wins.`, code: 'DUPLICATE_DOMAIN' })
    } else {
      seen.add(domain)
    }

    if (isDefault) defaultCount++

    for (const flowKey of ['flow_authentication', 'flow_invalidation', 'flow_recovery'] as const) {
      const v = String(item.fields[flowKey] ?? '').trim()
      if (v && !UUID_PATTERN.test(v)) {
        errors.push({ field: `items[${i}].${flowKey}`, message: `"${v}" is not a valid UUID.`, code: 'INVALID_FLOW_UUID' })
      }
    }
  })

  if (defaultCount > 1) {
    warnings.push({ field: 'items', message: `${defaultCount} brands are marked as default; only one will be used, chosen by authentik.`, code: 'MULTIPLE_DEFAULTS' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
