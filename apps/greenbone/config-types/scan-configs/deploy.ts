import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetConfigsCommand, buildCreateConfigCommand, buildModifyConfigCommand, parseConfigs } from '../../lib/gmp/scanConfigs'
import { buildScanConfigItem, findConfigByName } from './_shared'

/**
 * Deploy Greenbone scan configs over GMP (XML over TLS, 9390):
 *   read:   <get_configs usage_type="scan" filter="rows=-1"/> → find by name
 *   create: <create_config><copy>…</copy>…</create_config>   → clone-only (see
 *           lib/gmp/scanConfigs.ts); the new id is returned on the response
 *   tune:   <modify_config config_id="…">…                    → name/comment/
 *           family_selection/nvt_selection/preferences, applied EVERY deploy
 *           (create and update both end in the same modify_config call)
 *
 * The config NAME is the stable identity used to upsert. rollbackData records,
 * per config, whether we CREATED it (rollback deletes it) or MODIFIED an
 * existing one (recording the prior name/comment so rollback can restore
 * them — family/nvt/preferences are not restorable, see rollback.ts).
 */
interface Prior {
  name: string
  configId: string
  created: boolean
  restore: { name: string; comment: string } | null
}

async function listConfigs(session: GmpSession) {
  return parseConfigs(await session.send(buildGetConfigsCommand()))
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
        const live = await listConfigs(session)

        for (const item of items) {
          const built = buildScanConfigItem(item.fields)
          if (!built.name || !built.baseConfigId) continue

          const existing = findConfigByName(live, built.name)
          let configId: string
          let created: boolean
          let restore: { name: string; comment: string } | null = null

          if (existing) {
            configId = existing.id
            created = false
            restore = { name: existing.name, comment: existing.comment }
          } else {
            const raw = await session.send(buildCreateConfigCommand(built.baseConfigId, built.name))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_config "${built.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            configId = newId
            created = true
          }

          const tuneStatus = parseGmpStatus(await session.send(buildModifyConfigCommand(configId, built.modify)))
          if (!tuneStatus.ok) {
            throw new GmpError(`modify_config "${built.name}" failed (status ${tuneStatus.status}: ${tuneStatus.statusText})`, tuneStatus.status, tuneStatus.statusText)
          }

          previous.push({ name: built.name, configId, created, restore })
          applied.push(built.name)
        }

        return {
          success: true,
          message: `Applied ${applied.length} scan config(s): ${applied.join(', ') || '(none)'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Scan config deploy failed after ${applied.length} config(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
