// =============================================================================
// Five-field cron evaluation, UTC only. Mirrors the grammar `isValidCron`
// accepts (numbers, ranges, steps, lists, `*`; day-of-week 0-7 with 7 = Sunday)
// and applies the classic rule that a restricted day-of-month and a restricted
// day-of-week are OR-ed, otherwise AND-ed.
// =============================================================================

import { isValidCron } from '../model/validate'

export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  dayOfMonthRestricted: boolean
  dayOfWeekRestricted: boolean
}

const BOUNDS: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
const MINUTE = 60_000
const MAX_STEPS = 100_000

function expandField(field: string, [min, max]: readonly [number, number]): Set<number> {
  const out = new Set<number>()
  for (const token of field.split(',')) {
    const [base, stepText] = token.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    let from = min
    let to = max
    if (base !== '*') {
      const [a, b] = base.split('-').map(Number)
      from = a
      to = b ?? (stepText === undefined ? a : max)
    }
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out
}

export function parseCron(cron: string): CronFields {
  if (!isValidCron(cron)) throw new Error(`Invalid cron expression: ${cron}`)
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/)
  const dayOfWeek = expandField(dow, BOUNDS[4])
  if (dayOfWeek.has(7)) { dayOfWeek.delete(7); dayOfWeek.add(0) }
  return {
    minute: expandField(minute, BOUNDS[0]),
    hour: expandField(hour, BOUNDS[1]),
    dayOfMonth: expandField(dom, BOUNDS[2]),
    month: expandField(month, BOUNDS[3]),
    dayOfWeek,
    dayOfMonthRestricted: dom !== '*',
    dayOfWeekRestricted: dow !== '*',
  }
}

function dayMatches(fields: CronFields, date: Date): boolean {
  const dom = fields.dayOfMonth.has(date.getUTCDate())
  const dow = fields.dayOfWeek.has(date.getUTCDay())
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return dom || dow
  return dom && dow
}

export function cronMatches(cron: string | CronFields, date: Date): boolean {
  const fields = typeof cron === 'string' ? parseCron(cron) : cron
  return fields.month.has(date.getUTCMonth() + 1) && dayMatches(fields, date)
    && fields.hour.has(date.getUTCHours()) && fields.minute.has(date.getUTCMinutes())
}

const startOfNextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
const startOfNextDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
const startOfNextHour = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1))

/** The first minute strictly after `after` that the expression fires on. */
export function nextCronRun(cron: string | CronFields, after: Date): Date {
  const fields = typeof cron === 'string' ? parseCron(cron) : cron
  let cursor = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE)
  for (let i = 0; i < MAX_STEPS; i++) {
    if (!fields.month.has(cursor.getUTCMonth() + 1)) cursor = startOfNextMonth(cursor)
    else if (!dayMatches(fields, cursor)) cursor = startOfNextDay(cursor)
    else if (!fields.hour.has(cursor.getUTCHours())) cursor = startOfNextHour(cursor)
    else if (!fields.minute.has(cursor.getUTCMinutes())) cursor = new Date(cursor.getTime() + MINUTE)
    else return cursor
  }
  throw new Error(`Cron expression never fires: ${typeof cron === 'string' ? cron : '<fields>'}`)
}
