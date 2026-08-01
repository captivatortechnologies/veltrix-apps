import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeBool, trimStr } from '../../lib/tableRecords'
import { RUN_TYPE_VALUES } from './_shared'

/**
 * Validate scheduled-job items. Static — no target access required:
 *   - a non-empty name
 *   - a valid run_type
 *   - a non-empty script
 * Identity is `name`; a duplicate name is flagged (last one wins). Schedule
 * completeness (day-of-week for weekly, interval for periodically) and a
 * conditional job with no condition are warnings, not errors.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scheduled job.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = trimStr(item.fields.name)
    const runType = trimStr(item.fields.runType) || 'daily'
    const script = trimStr(item.fields.script)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    }

    if (!RUN_TYPE_VALUES.has(runType)) {
      errors.push({
        field: `items[${i}].runType`,
        message: `Run type must be one of daily, weekly, monthly, periodically, once, on_demand (got "${runType}").`,
        code: 'INVALID_RUN_TYPE',
      })
    }

    if (!script) {
      errors.push({ field: `items[${i}].script`, message: 'Script is required for a scheduled job.', code: 'EMPTY_SCRIPT' })
    }

    if (runType === 'weekly' && !trimStr(item.fields.runDayofweek)) {
      warnings.push({
        field: `items[${i}].runDayofweek`,
        message: `Weekly job "${name || '(unnamed)'}" has no day of week set (run_dayofweek).`,
        code: 'MISSING_DAYOFWEEK',
      })
    }

    if (runType === 'periodically' && !trimStr(item.fields.runPeriod)) {
      warnings.push({
        field: `items[${i}].runPeriod`,
        message: `Periodic job "${name || '(unnamed)'}" has no interval set (run_period).`,
        code: 'MISSING_PERIOD',
      })
    }

    if (normalizeBool(item.fields.conditional) && !trimStr(item.fields.condition)) {
      warnings.push({
        field: `items[${i}].condition`,
        message: `Job "${name || '(unnamed)'}" is conditional but has no condition script — it will always run.`,
        code: 'EMPTY_CONDITION',
      })
    }

    if (name) {
      if (seen.has(name)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Scheduled job "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(name)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
