import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  withGmpSession, resolveGmpHost, resolveGmpPort,
  buildGetTasksCommand, buildGetTargetsCommand, buildGetScanConfigsCommand, buildGetScannersCommand, buildGetSchedulesCommand,
  buildCreateTaskCommand, buildModifyTaskCommand,
  parseTasks, parseTargets, parseScanConfigs, parseScanners, parseSchedules,
  parseGmpStatus, parseCreatedId, GmpError, type GmpSession,
} from '../../lib/greenboneApi'
import { buildTaskFields, findTaskByName, resolveTaskRefs, type LiveLookups } from './_shared'

/**
 * Deploy Greenbone scan tasks over GMP (XML over TLS, 9390):
 *   read:   <get_targets/>, <get_configs usage_type="scan"/>, <get_scanners/>,
 *           <get_schedules/>  → resolve target/config/scanner/schedule NAME → id
 *           <get_tasks usage_type="scan"/>  → find the live task by name
 *   create: <create_task>…</create_task>   (needs <usage_type>scan</usage_type>)
 *   update: <modify_task task_id="…">…       (task already exists)
 *
 * Foreign keys are resolved BY NAME (or a pasted UUID) against the live gvmd. The
 * task NAME is the stable identity used to upsert. On modify, config/target/scanner
 * are only re-sent when they actually changed — gvmd rejects re-pointing them on a
 * task that has run unless it is alterable (gvmd #1305), so an unchanged re-deploy
 * never trips that.
 */
interface Prior {
  name: string
  taskId: string
  created: boolean
  restore: { name: string; comment: string; configId: string; targetId: string; scannerId: string; scheduleId: string } | null
}

async function loadLookups(session: GmpSession): Promise<LiveLookups> {
  return {
    targets: parseTargets(await session.send(buildGetTargetsCommand())),
    configs: parseScanConfigs(await session.send(buildGetScanConfigsCommand())),
    scanners: parseScanners(await session.send(buildGetScannersCommand())),
    schedules: parseSchedules(await session.send(buildGetSchedulesCommand())),
  }
}

/** gvmd represents "no schedule" as id 0; normalise both directions for comparison. */
const scheduleOf = (id: string | undefined): string => (id && id !== '0' ? id : '')

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
        const lookups = await loadLookups(session)
        const liveTasks = parseTasks(await session.send(buildGetTasksCommand()))

        for (const item of items) {
          const fields = buildTaskFields(item.fields)
          if (!fields.name || !fields.target || !fields.config || !fields.scanner) continue

          const { resolved, missing } = resolveTaskRefs(fields, lookups)
          if (!resolved) {
            throw new GmpError(`scan task "${fields.name}": could not resolve ${missing.join(', ')} on the live gvmd`)
          }

          const existing = findTaskByName(liveTasks, fields.name)
          if (existing) {
            // Re-send config/target/scanner ONLY when they changed (see FLAG / gvmd #1305).
            const changes: Parameters<typeof buildModifyTaskCommand>[1] = {
              name: fields.name,
              comment: fields.comment ?? '',
            }
            if (resolved.configId !== existing.configId) changes.configId = resolved.configId
            if (resolved.targetId !== existing.targetId) changes.targetId = resolved.targetId
            if (resolved.scannerId !== existing.scannerId) changes.scannerId = resolved.scannerId
            if (scheduleOf(resolved.scheduleId) !== scheduleOf(existing.scheduleId)) {
              changes.scheduleId = resolved.scheduleId || '0' // id 0 clears the schedule
            }

            const st = parseGmpStatus(await session.send(buildModifyTaskCommand(existing.id, changes)))
            if (!st.ok) throw new GmpError(`modify_task "${fields.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({
              name: fields.name,
              taskId: existing.id,
              created: false,
              restore: {
                name: existing.name,
                comment: existing.comment,
                configId: existing.configId,
                targetId: existing.targetId,
                scannerId: existing.scannerId,
                scheduleId: scheduleOf(existing.scheduleId),
              },
            })
          } else {
            const raw = await session.send(
              buildCreateTaskCommand({
                name: fields.name,
                configId: resolved.configId,
                targetId: resolved.targetId,
                scannerId: resolved.scannerId,
                scheduleId: resolved.scheduleId,
                comment: fields.comment,
              }),
            )
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_task "${fields.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: fields.name, taskId: newId, created: true, restore: null })
          }
          applied.push(fields.name)
        }

        return {
          success: true,
          message: `Applied ${applied.length} scan task(s): ${applied.join(', ') || '(none)'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Scan task deploy failed after ${applied.length} task(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
