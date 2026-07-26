import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  parseJson,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/qradar'
import type { RollbackEntry } from './deploy'
import type { LiveReferenceSet } from './validate'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.existed) {
      // We created this one — remove it.
      const resp = await client.deleteSet(e.name)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${e.name}: ${qradarErrorMessage(resp)}`)
      else deleted++
    } else {
      // We updated its values — restore the prior value set.
      const prior = new Set(e.priorValues ?? [])
      const getRes = await client.getSet(e.name)
      if (!getRes.ok) {
        failures.push(`restore ${e.name}: ${qradarErrorMessage(getRes)}`)
        continue
      }
      const live = parseJson<LiveReferenceSet>(getRes.body)
      const current = new Set((live?.data ?? []).map((d) => d.value ?? '').filter(Boolean))
      for (const v of prior) if (!current.has(v)) {
        const r = await client.addValue(e.name, v)
        if (!r.ok) failures.push(`restore ${e.name}: add "${v}": ${qradarErrorMessage(r)}`)
      }
      for (const v of current) if (!prior.has(v)) {
        const r = await client.deleteValue(e.name, v)
        if (!r.ok && r.status !== 404) failures.push(`restore ${e.name}: remove "${v}": ${qradarErrorMessage(r)}`)
      }
      restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back reference sets: ${deleted} deleted, ${restored} restored` }
}
