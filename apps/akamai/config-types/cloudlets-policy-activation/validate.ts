import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORKS } from './_shared'

/**
 * Validate Cloudlets Policy Activation items: a non-empty policy name, a
 * positive version number and a known network (STAGING/PRODUCTION). Static —
 * no target access required (whether the policy/version actually exists is
 * checked at deploy time). The (policyName, network) pair is the identity, so
 * a duplicate pair is flagged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one activation.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const policyName = String(item.fields.policyName ?? '').trim()
    const rawNetwork = String(item.fields.network ?? '').trim().toUpperCase()
    const version = item.fields.policyVersion

    if (!policyName) {
      errors.push({ field: `items[${i}].policyName`, message: 'Policy name is required.', code: 'EMPTY_POLICY_NAME' })
    }

    if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) {
      errors.push({ field: `items[${i}].policyVersion`, message: 'Policy version must be a positive number.', code: 'INVALID_VERSION' })
    }

    if (!NETWORKS.has(rawNetwork)) {
      errors.push({ field: `items[${i}].network`, message: `Environment must be STAGING or PRODUCTION (got "${rawNetwork || '(empty)'}").`, code: 'INVALID_NETWORK' })
    }

    if (policyName && NETWORKS.has(rawNetwork)) {
      const key = `${policyName.toLowerCase()} ${rawNetwork}`
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].policyName`, message: `"${policyName}" → ${rawNetwork} is listed more than once; the last one wins.`, code: 'DUPLICATE_TARGET' })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
