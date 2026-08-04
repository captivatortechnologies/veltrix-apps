// =============================================================================
// Shared helpers for the Firewall Schedules config type (validate + deploy +
// rollback + drift). Field shapes verified against
// RESTAPI/Models/FirewallSchedule.inc and
// RESTAPI/Models/FirewallScheduleTimeRange.inc.
//
// IDENTITY: `name` (StringField unique:true) — natural key, like aliases.
// Unlike aliases/gateways, `name` here has NO `editable: false` override, so
// pfSense itself allows renaming a schedule via PATCH — this app still
// matches by CURRENT declared name (same as its other name-keyed config
// types), so a rename in the canvas is a delete+recreate here too, not an
// atomic PATCH-rename.
//
// SCOPE (v0.3.0): exactly ONE embedded time range per schedule (the common
// case) — see lib/pfsenseApi.ts's module doc for why multiple time ranges
// per schedule (e.g. different hours on different days) is out of scope.
// Within that one time range, `position` (recurring weekdays) and
// `month`+`day` (specific date pairs) remain mutually exclusive, matching
// the underlying API exactly.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { FirewallSchedule } from '../../lib/pfsenseApi'

export const MAX_NAME_LENGTH = 31
export const MAX_DESCRIPTION_LENGTH = 1024

/** `SUPPORTED_MINUTES` verified against FirewallScheduleTimeRange.inc — an unusual, asymmetric set (00/15/30/45/59), not every 15 minutes. */
export const SUPPORTED_MINUTES = ['00', '15', '30', '45', '59']

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/
/** Days-in-month lookup verified against FirewallScheduleTimeRange::is_day_in_month() — Feb is HARDCODED to 29 (not leap-year-aware); replicated faithfully, not "fixed". */
export const DAYS_IN_MONTH: Record<number, number> = { 1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31 }

function parseTime(value: string): { minutes: number; mm: string } | null {
  const m = TIME_RE.exec(value)
  if (!m) return null
  return { minutes: Number(m[1]) * 60 + Number(m[2]), mm: m[2] }
}

/** `hour` validation verified against FirewallScheduleTimeRange::validate_hour(): "H:MM-H:MM" or "HH:MM-HH:MM", both sides in SUPPORTED_MINUTES, start <= end (same-day only — an overnight range like 22:00-02:00 is rejected by the API itself, replicated here). */
export function isValidHourRange(value: string): boolean {
  const parts = value.split('-')
  if (parts.length !== 2) return false
  const start = parseTime(parts[0])
  const end = parseTime(parts[1])
  if (!start || !end) return false
  if (!SUPPORTED_MINUTES.includes(start.mm) || !SUPPORTED_MINUTES.includes(end.mm)) return false
  return start.minutes <= end.minutes
}

function numList(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((v) => Number(v)).filter((n) => Number.isInteger(n))
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n))
  }
  return []
}

export interface ScheduleSpec {
  itemId?: string
  name: string
  descr: string
  position: number[]
  month: number[]
  day: number[]
  hour: string
  rangedescr: string
}

export function specFromItem(item: CanvasItemSnapshot): ScheduleSpec {
  const f = item.fields ?? {}
  return {
    itemId: item.id,
    name: String(f.name ?? '').trim(),
    descr: String(f.descr ?? '').trim(),
    position: numList(f.position),
    month: numList(f.month),
    day: numList(f.day),
    hour: String(f.hour ?? '').trim(),
    rangedescr: String(f.rangedescr ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): ScheduleSpec[] {
  return items.map(specFromItem)
}

/** Schedule-name identity — exact match, case-sensitive (matches FilterNameValidator's charset, which is case-preserving). */
export function scheduleKey(name: string): string {
  return name.trim()
}

/** True when this schedule uses recurring weekdays instead of specific month+day date pairs (mutually exclusive, per the API). */
export function usesRecurringDays(spec: ScheduleSpec): boolean {
  return spec.position.length > 0
}

export function toScheduleBody(spec: ScheduleSpec): Omit<FirewallSchedule, 'id'> {
  const recurring = usesRecurringDays(spec)
  return {
    name: spec.name,
    descr: spec.descr,
    timerange: [
      recurring
        ? { position: spec.position, hour: spec.hour, rangedescr: spec.rangedescr }
        : { position: null, month: spec.month, day: spec.day, hour: spec.hour, rangedescr: spec.rangedescr },
    ],
  }
}

export function snapshotSchedule(live: FirewallSchedule): Omit<FirewallSchedule, 'id'> {
  return {
    name: live.name,
    descr: live.descr ?? '',
    timerange: Array.isArray(live.timerange) ? live.timerange : [],
  }
}
