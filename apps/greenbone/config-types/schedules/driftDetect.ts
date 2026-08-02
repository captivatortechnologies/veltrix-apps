import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, buildGetSchedulesCommand, parseSchedules } from '../../lib/greenboneApi'
import { buildScheduleInput, findScheduleByName, normalizeIcal } from './_shared'

/**
 * Drift for schedules: compare the timezone, comment and the meaningful iCalendar
 * keys (DTSTART/DTEND/DURATION/RRULE) we declare against the live schedule in
 * gvmd. iCalendar is compared via normalizeIcal() so gvmd's reformatting (line
 * folding, TZID, reordering) does not raise false drift. Best-effort — a schedule
 * that can't be matched is skipped. Read-only: <get_schedules/>. GMP over TLS 9390.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential || !credential.username || !credential.password) return { hasDrift: false, diffs }

  let live
  try {
    live = await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component), timeoutMs: 8000 },
      { username: credential.username, password: credential.password },
      async (session) => parseSchedules(await session.send(buildGetSchedulesCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read schedules, no drift asserted
  }

  for (const item of items) {
    const input = buildScheduleInput(item.fields)
    const match = findScheduleByName(live, input.name)
    if (!match) continue
    const label = input.name

    const expectedIcal = normalizeIcal(input.icalendar)
    const actualIcal = normalizeIcal(match.icalendar)
    if (expectedIcal !== actualIcal) {
      diffs.push({ field: `${label}.icalendar`, expected: expectedIcal, actual: actualIcal, severity: 'warning' })
    }

    if (input.timezone && input.timezone.trim() !== match.timezone.trim()) {
      diffs.push({ field: `${label}.timezone`, expected: input.timezone, actual: match.timezone, severity: 'warning' })
    }

    const expectedComment = (input.comment ?? '').trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${label}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
