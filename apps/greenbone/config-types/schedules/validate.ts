import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { looksLikeIcalendar, hasDtStart, hasRrule } from './_shared'

/**
 * Validate schedule items: a non-empty name, a timezone, and iCalendar text that
 * looks like a VCALENDAR/VEVENT with a start. Static — no gvmd access required.
 * Schedule names double as the upsert identity, so a duplicate name is flagged
 * (last one wins). FLAG: gvmd only keeps DTSTART/DTEND/DURATION/RRULE from the
 * VEVENT (GMP 20.08+ icalendar model).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one schedule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const icalendar = String(item.fields.icalendar ?? '').trim()
    const timezone = String(item.fields.timezone ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Schedule name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Schedule name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!timezone) {
      errors.push({ field: `items[${i}].timezone`, message: 'A timezone is required (e.g. UTC or Europe/Berlin).', code: 'EMPTY_TIMEZONE' })
    } else if (timezone !== 'UTC' && !/^[A-Za-z]+\/[A-Za-z0-9._+-]+$/.test(timezone)) {
      warnings.push({ field: `items[${i}].timezone`, message: `Timezone "${timezone}" is not an IANA name like "UTC" or "Europe/Berlin"; gvmd may reject it.`, code: 'SUSPECT_TIMEZONE' })
    }

    if (!icalendar) {
      errors.push({ field: `items[${i}].icalendar`, message: 'iCalendar data is required (a VCALENDAR with a VEVENT).', code: 'EMPTY_ICALENDAR' })
    } else if (!looksLikeIcalendar(icalendar)) {
      errors.push({ field: `items[${i}].icalendar`, message: 'iCalendar must contain BEGIN:VCALENDAR … BEGIN:VEVENT … END:VCALENDAR.', code: 'INVALID_ICALENDAR' })
    } else {
      if (!hasDtStart(icalendar)) {
        errors.push({ field: `items[${i}].icalendar`, message: 'The VEVENT needs a DTSTART; a schedule with no start never fires.', code: 'MISSING_DTSTART' })
      }
      if (!hasRrule(icalendar)) {
        warnings.push({ field: `items[${i}].icalendar`, message: 'No RRULE — this schedule runs once at DTSTART (not recurring).', code: 'NO_RRULE' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
