import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseSubnetList, isIpOrCidr } from './_shared'

/**
 * Validate the Internal Networks singleton. Static — no target access required.
 *   - exactly one item (a brain-wide singleton).
 *   - every declared subnet in include/exclude/drop must be a valid IPv4 address or
 *     CIDR range.
 *   - warns when all three lists are empty (deploy would clear the brain's entire
 *     internal-network configuration — a full replace, not a merge).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Internal Networks is a singleton — add exactly one configuration.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    errors.push({ field: 'items', message: 'Internal Networks is a brain-wide singleton — declare exactly one configuration.', code: 'SINGLETON' })
  }

  items.forEach((item, i) => {
    const f = item.fields
    const lists: Array<['include' | 'exclude' | 'drop', string[]]> = [
      ['include', parseSubnetList(f.include)],
      ['exclude', parseSubnetList(f.exclude)],
      ['drop', parseSubnetList(f.drop)],
    ]

    lists.forEach(([key, list]) => {
      list.forEach((subnet) => {
        if (!isIpOrCidr(subnet)) {
          errors.push({ field: `items[${i}].${key}`, message: `"${subnet}" is not a valid IPv4 address or CIDR range.`, code: 'INVALID_SUBNET' })
        }
      })
    })

    if (lists.every(([, list]) => list.length === 0)) {
      warnings.push({
        field: `items[${i}]`,
        message: 'No subnets declared — deploying will clear the internal, excluded and dropped subnet lists on the brain (full replace).',
        code: 'EMPTY_REPLACE',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
