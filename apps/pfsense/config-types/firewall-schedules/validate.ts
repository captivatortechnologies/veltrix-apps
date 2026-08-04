import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { DAYS_IN_MONTH, MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, isValidHourRange, scheduleKey, specFromItem, usesRecurringDays } from './_shared'

const NAME_CHARSET_RE = /^[A-Za-z0-9_]+$/
const ALL_DIGITS_RE = /^\d+$/

/**
 * Validate schedule items against pfSense's own rules (schema-only, no live
 * API calls):
 *   - name required, <=31 chars, [A-Za-z0-9_] charset, not all-digits, unique per canvas
 *   - EITHER position (1-7, up to 7 values) OR month+day (1-12 / 1-31, same
 *     length, each day valid within its month per DAYS_IN_MONTH) — required
 *   - hour required, "HH:MM-HH:MM" with supported minutes and start<=end
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one firewall schedule.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer (got ${spec.name.length}).`, code: 'NAME_TOO_LONG' })
    } else if (ALL_DIGITS_RE.test(spec.name) || !NAME_CHARSET_RE.test(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: 'Name may only contain letters, numbers and underscores, and may not be purely numeric.', code: 'INVALID_NAME' })
    } else {
      const key = scheduleKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate schedule name "${spec.name}" — each name may only be declared once per canvas.`, code: 'DUPLICATE_NAME' })
      }
      seen.add(key)
    }

    if (usesRecurringDays(spec)) {
      if (spec.position.length > 7) {
        errors.push({ field: `${prefix}.position`, message: 'Days of Week supports at most 7 values.', code: 'TOO_MANY_DAYS' })
      }
      spec.position.forEach((p, j) => {
        if (p < 1 || p > 7) errors.push({ field: `${prefix}.position[${j}]`, message: `"${p}" is not a valid day of week (1-7).`, code: 'INVALID_POSITION' })
      })
      if (spec.month.length > 0 || spec.day.length > 0) {
        warnings.push({ field: `${prefix}.month`, message: 'Month/Day are ignored while Days of Week is set.', code: 'MONTH_DAY_IGNORED' })
      }
    } else {
      if (spec.month.length === 0 || spec.day.length === 0) {
        errors.push({ field: `${prefix}.month`, message: 'Set either Days of Week, or both Month and Day.', code: 'EMPTY_DATE_SPEC' })
      } else if (spec.month.length !== spec.day.length) {
        errors.push({ field: `${prefix}.day`, message: `Month (${spec.month.length}) and Day (${spec.day.length}) must have the same number of values.`, code: 'MONTH_DAY_COUNT_MISMATCH' })
      } else {
        spec.month.forEach((m, j) => {
          const d = spec.day[j]
          if (m < 1 || m > 12) {
            errors.push({ field: `${prefix}.month[${j}]`, message: `"${m}" is not a valid month (1-12).`, code: 'INVALID_MONTH' })
          } else if (d === undefined || d < 1 || d > DAYS_IN_MONTH[m]) {
            errors.push({ field: `${prefix}.day[${j}]`, message: `"${d}" is not a valid day for month ${m}.`, code: 'INVALID_DAY_FOR_MONTH' })
          }
        })
      }
    }

    if (!spec.hour) {
      errors.push({ field: `${prefix}.hour`, message: 'Time Range is required.', code: 'EMPTY_HOUR' })
    } else if (!isValidHourRange(spec.hour)) {
      errors.push({
        field: `${prefix}.hour`,
        message: `"${spec.hour}" is not a valid time range — use HH:MM-HH:MM with minutes of :00/:15/:30/:45/:59, start at or before end.`,
        code: 'INVALID_HOUR',
      })
    }

    if (spec.descr.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.descr`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.descr.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
