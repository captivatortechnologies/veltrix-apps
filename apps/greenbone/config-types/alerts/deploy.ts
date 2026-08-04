import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetAlertsCommand, buildCreateAlertCommand, buildModifyAlertCommand, parseAlerts, type AlertInput } from '../../lib/gmp/alerts'
import { buildAlertInput, findAlertByName } from './_shared'

/**
 * Deploy Greenbone alerts over GMP (XML over TLS, 9390):
 *   read:   <get_alerts filter="rows=-1"/>          → find by name
 *   create: <create_alert>…</create_alert>          → new id on the response
 *   update: <modify_alert alert_id="…">…             (always resends
 *           name/condition/event/method together — see lib/gmp/alerts.ts)
 *
 * The alert NAME is the stable identity used to upsert. rollbackData records,
 * per alert, whether we CREATED it (rollback deletes it) or MODIFIED an
 * existing one (recording the prior clauses so rollback can restore them).
 */
interface Prior {
  name: string
  alertId: string
  created: boolean
  restore: AlertInput | null
}

async function listAlerts(session: GmpSession) {
  return parseAlerts(await session.send(buildGetAlertsCommand()))
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
        const live = await listAlerts(session)

        for (const item of items) {
          const input = buildAlertInput(item.fields)
          if (!input.name) continue

          const existing = findAlertByName(live, input.name)
          if (existing) {
            const st = parseGmpStatus(await session.send(buildModifyAlertCommand(existing.id, input)))
            if (!st.ok) throw new GmpError(`modify_alert "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({
              name: input.name,
              alertId: existing.id,
              created: false,
              restore: { name: existing.name, event: existing.event, condition: existing.condition, method: existing.method, comment: existing.comment },
            })
          } else {
            const raw = await session.send(buildCreateAlertCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_alert "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: input.name, alertId: newId, created: true, restore: null })
          }
          applied.push(input.name)
        }

        return {
          success: true,
          message: `Applied ${applied.length} alert(s): ${applied.join(', ') || '(none)'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Alert deploy failed after ${applied.length} alert(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
