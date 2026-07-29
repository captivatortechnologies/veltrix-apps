import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate ILM policy items: a safe policy name, positive phase numbers, and a
 * total retention that is not shorter than the hot rollover age. Static — no
 * target access required. Numbers may arrive as number or string; coerce first.
 */
const NAME_RE = /^[a-zA-Z0-9._-]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one ILM policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const policyName = String(item.fields.policyName ?? '').trim()
    const hotMaxAgeDays = Number(item.fields.hotMaxAgeDays)
    const deleteMinAgeDays = Number(item.fields.deleteMinAgeDays)
    const hotShardRaw = item.fields.hotMaxPrimaryShardSizeGb
    const hasShard = hotShardRaw !== undefined && hotShardRaw !== null && String(hotShardRaw).trim() !== ''
    const hotMaxPrimaryShardSizeGb = Number(hotShardRaw)

    if (!policyName) {
      errors.push({ field: `items[${i}].policyName`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(policyName)) {
      errors.push({ field: `items[${i}].policyName`, message: `Policy name "${policyName}" may only contain letters, numbers, dot, underscore or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(policyName)) {
      warnings.push({ field: `items[${i}].policyName`, message: `Policy ${policyName} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(policyName)
    }

    if (!Number.isFinite(hotMaxAgeDays) || hotMaxAgeDays <= 0) {
      errors.push({ field: `items[${i}].hotMaxAgeDays`, message: 'Hot max age (days) must be a positive number.', code: 'INVALID_HOT_AGE' })
    }

    if (!Number.isFinite(deleteMinAgeDays) || deleteMinAgeDays <= 0) {
      errors.push({ field: `items[${i}].deleteMinAgeDays`, message: 'Total retention (days) must be a positive number.', code: 'INVALID_RETENTION' })
    }

    if (
      Number.isFinite(hotMaxAgeDays) && hotMaxAgeDays > 0 &&
      Number.isFinite(deleteMinAgeDays) && deleteMinAgeDays > 0 &&
      deleteMinAgeDays < hotMaxAgeDays
    ) {
      errors.push({
        field: `items[${i}].deleteMinAgeDays`,
        message: `Total retention (${deleteMinAgeDays}d) cannot be shorter than the hot max age (${hotMaxAgeDays}d).`,
        code: 'RETENTION_TOO_SHORT',
      })
    }

    if (hasShard && (!Number.isFinite(hotMaxPrimaryShardSizeGb) || hotMaxPrimaryShardSizeGb <= 0)) {
      errors.push({ field: `items[${i}].hotMaxPrimaryShardSizeGb`, message: 'Hot max primary shard size (GB) must be a positive number when set.', code: 'INVALID_SHARD_SIZE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
