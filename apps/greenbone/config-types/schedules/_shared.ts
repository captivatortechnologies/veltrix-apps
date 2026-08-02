// Shared helpers for the Greenbone Schedules config type (deploy + rollback +
// drift). A schedule is a named recurrence expressed as iCalendar (RFC 5545)
// data plus a timezone. Applied over GMP (XML over TLS). The schedule NAME is the
// stable identity used to upsert — gvmd does not enforce unique names, so this app
// treats the name as the key (last one wins on a duplicate).
//
// FLAG (GMP 20.08+ / 22.5): create_schedule/modify_schedule take a single
// <icalendar> element (not the pre-20.08 <first_time>/<period>/<duration> model).
// gvmd keeps only DTSTART/DTEND/DURATION/RRULE from the VEVENT and normalises the
// text it echoes back, so drift compares those extracted keys, not the raw string.

import type { GmpSchedule, ScheduleInput } from '../../lib/greenboneApi'

/** Build the GMP schedule input from a canvas item's fields. */
export function buildScheduleInput(fields: Record<string, unknown>): ScheduleInput {
  return {
    name: String(fields.name ?? '').trim(),
    icalendar: String(fields.icalendar ?? '').trim(),
    timezone: String(fields.timezone ?? '').trim() || 'UTC',
    comment: String(fields.comment ?? '').trim(),
  }
}

/** Find a live schedule by name (trimmed, case-sensitive — GMP names are case-sensitive). */
export function findScheduleByName(schedules: GmpSchedule[], name: string): GmpSchedule | null {
  const n = name.trim()
  if (!n) return null
  return schedules.find((s) => s.name.trim() === n) ?? null
}

/**
 * Extract the meaningful, gvmd-retained keys (DTSTART / DTEND / DURATION / RRULE)
 * from iCalendar text for a drift comparison that survives gvmd's reformatting
 * (line folding, TZID handling, property reordering). Case-insensitive on the
 * property name; whitespace is stripped from each value.
 */
export function icalKeys(icalendar: unknown): Record<string, string> {
  const keys: Record<string, string> = {}
  const text = String(icalendar ?? '').replace(/\r\n[ \t]/g, '') // unfold RFC 5545 line folding
  for (const line of text.split(/\r?\n/)) {
    const m = /^(DTSTART|DTEND|DURATION|RRULE)\b[^:]*:(.*)$/i.exec(line.trim())
    if (m) keys[m[1].toUpperCase()] = m[2].replace(/\s+/g, '').toUpperCase()
  }
  return keys
}

/** Canonical, comparison-stable form of the retained iCalendar keys. */
export function normalizeIcal(icalendar: unknown): string {
  const keys = icalKeys(icalendar)
  return Object.keys(keys)
    .sort()
    .map((k) => `${k}=${keys[k]}`)
    .join(';')
}

/** Does the text look like a usable iCalendar VEVENT (for static validation)? */
export function looksLikeIcalendar(icalendar: unknown): boolean {
  const text = String(icalendar ?? '')
  return /BEGIN:VCALENDAR/i.test(text) && /END:VCALENDAR/i.test(text) && /BEGIN:VEVENT/i.test(text)
}

/** Does the VEVENT declare a start (DTSTART)? A schedule with no start never fires. */
export function hasDtStart(icalendar: unknown): boolean {
  return /(^|\n)\s*DTSTART\b[^:]*:/i.test(String(icalendar ?? ''))
}

/** Does the VEVENT recur (RRULE)? Absence is a valid one-shot schedule (info-level). */
export function hasRrule(icalendar: unknown): boolean {
  return /(^|\n)\s*RRULE\b[^:]*:/i.test(String(icalendar ?? ''))
}
