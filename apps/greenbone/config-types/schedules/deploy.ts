import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, buildGetSchedulesCommand, buildCreateScheduleCommand, buildModifyScheduleCommand, parseGmpStatus, parseCreatedId, parseSchedules, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildScheduleInput, findScheduleByName } from './_shared'

/**
 * Deploy Greenbone scan schedules over GMP (XML over TLS, 9390):
 *   read:   <get_schedules filter="rows=-1"/>       → find the live schedule by name
 *   create: <create_schedule>…</create_schedule>    → new id returned on the response
 *   update: <modify_schedule schedule_id="…">…       (schedule already exists)
 *
 * The schedule NAME is the stable identity used to upsert. rollbackData records,
 * per schedule, whether we CREATED it (rollback deletes it) or MODIFIED an
 * existing one (recording the prior name/icalendar/timezone/comment so rollback
 * can restore it). FLAG: gvmd keeps only DTSTART/DTEND/DURATION/RRULE from the
 * icalendar (GMP 20.08+ model) and reformats the rest.
 */
interface Prior {
  name: string
  scheduleId: string
  created: boolean
  restore: { name: string; icalendar: string; timezone: string; comment: string } | null
}

async function listSchedules(session: GmpSession) {
  return parseSchedules(await session.send(buildGetSchedulesCommand()))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone deploy needs a connection credential with a username and password.' }
  }

  const previous: Prior[] = []
  const applied: string[] = []

  try {
    return await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        const live = await listSchedules(session)

        for (const item of items) {
          const input = buildScheduleInput(item.fields)
          if (!input.name || !input.icalendar || !input.timezone) continue

          const existing = findScheduleByName(live, input.name)
          if (existing) {
            const raw = await session.send(
              buildModifyScheduleCommand(existing.id, {
                name: input.name,
                icalendar: input.icalendar,
                timezone: input.timezone,
                comment: input.comment ?? '',
              }),
            )
            const st = parseGmpStatus(raw)
            if (!st.ok) throw new GmpError(`modify_schedule "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({
              name: input.name,
              scheduleId: existing.id,
              created: false,
              restore: { name: existing.name, icalendar: existing.icalendar, timezone: existing.timezone, comment: existing.comment },
            })
          } else {
            const raw = await session.send(buildCreateScheduleCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_schedule "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: input.name, scheduleId: newId, created: true, restore: null })
          }
          applied.push(input.name)
        }

        return {
          success: true,
          message: `Applied ${applied.length} schedule(s): ${applied.join(', ') || '(none)'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Schedule deploy failed after ${applied.length} schedule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
