import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { replaceConditionSets, type RollbackEntry } from './deploy'

const BASE = '/policies/permissionGrantPolicies'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.id) continue
    if (e.existed && e.prior) {
      const meta = await client.patch(`${BASE}/${e.id}`, {
        displayName: e.prior.displayName,
        description: e.prior.description ?? null,
      })
      if (!meta.ok && meta.status !== 404) {
        failures.push(`restore ${e.name}: ${graphErrorMessage(meta)}`)
        continue
      }
      const inclErr = await replaceConditionSets(client, e.id, 'includes', e.prior.includes ?? [])
      const exclErr = await replaceConditionSets(client, e.id, 'excludes', e.prior.excludes ?? [])
      if (inclErr || exclErr) failures.push(`restore ${e.name}: ${inclErr ?? exclErr}`)
      else restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${BASE}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${graphErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back permission grant policies: ${deleted} deleted, ${restored} restored` }
}
