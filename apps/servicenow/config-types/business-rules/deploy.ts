import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildServiceNowClient,
  resultList,
  resultObject,
  serviceNowErrorMessage,
} from '../../lib/servicenowApi'
import {
  SYS_SCRIPT_TABLE,
  MANAGED_COLUMNS,
  buildRecordBody,
  findRecord,
  identityQuery,
  managedSnapshot,
  type SysScriptRecord,
} from './_shared'

/**
 * Deploy ServiceNow business rules over the Table API:
 *   lookup: GET   /table/sys_script?sysparm_query=name=<n>^collection=<t>  (identity)
 *   create: POST  /table/sys_script                    with the rule body
 *   update: PATCH /table/sys_script/<sys_id>           with the rule body
 *
 * Identity is the (name, collection) pair. rollbackData records, per rule, the
 * prior managed field values (null when the rule did not exist) AND its sys_id —
 * so rollback can restore the prior values or delete the one we created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildServiceNowClient(component?.hostname, credential, settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: Array<{ name: string; collection: string; sysId: string | null; record: Record<string, unknown> | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      const collection = String(item.fields.collection ?? '').trim()
      if (!name || !collection) continue

      const lookup = await client.list(SYS_SCRIPT_TABLE, {
        query: identityQuery(name, collection),
        fields: ['sys_id', ...MANAGED_COLUMNS],
        limit: 1,
      })
      if (!lookup.ok) {
        throw new Error(`Lookup of "${name}" on ${collection} failed (HTTP ${lookup.status}): ${serviceNowErrorMessage(lookup)}`)
      }
      const existing = findRecord(resultList(lookup) as SysScriptRecord[], name, collection)
      const body = buildRecordBody(item.fields)

      if (existing && existing.sys_id) {
        const res = await client.update(SYS_SCRIPT_TABLE, String(existing.sys_id), body)
        if (!res.ok) {
          throw new Error(`Update of "${name}" failed (HTTP ${res.status}): ${serviceNowErrorMessage(res)}`)
        }
        previous.push({ name, collection, sysId: String(existing.sys_id), record: managedSnapshot(existing) })
      } else {
        const res = await client.create(SYS_SCRIPT_TABLE, body)
        if (!res.ok) {
          throw new Error(`Create of "${name}" failed (HTTP ${res.status}): ${serviceNowErrorMessage(res)}`)
        }
        const created = resultObject(res)
        const newId = created && typeof created.sys_id === 'string' ? created.sys_id : null
        previous.push({ name, collection, sysId: newId, record: null })
      }
      applied.push(`${name} (${collection})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} business rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Business-rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
