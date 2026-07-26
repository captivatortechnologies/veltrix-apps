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
import type { LiveReferenceMap } from './validate'

const enc = encodeURIComponent

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
      const resp = await client.request('DELETE', `/reference_data/maps/${enc(e.name)}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${e.name}: ${qradarErrorMessage(resp)}`)
      else deleted++
    } else {
      const prior = new Map((e.priorEntries ?? []).map((p) => [p.key, p.value]))
      const getRes = await client.request('GET', `/reference_data/maps/${enc(e.name)}`, { range: 'items=0-9999' })
      if (!getRes.ok) {
        failures.push(`restore ${e.name}: ${qradarErrorMessage(getRes)}`)
        continue
      }
      const live = parseJson<LiveReferenceMap>(getRes.body)
      const current = new Set(Object.keys(live?.data ?? {}))
      for (const [key, value] of prior) {
        const r = await client.request('POST', `/reference_data/maps/${enc(e.name)}?key=${enc(key)}&value=${enc(value)}`)
        if (!r.ok) failures.push(`restore ${e.name}: set "${key}": ${qradarErrorMessage(r)}`)
      }
      for (const key of current) {
        if (!prior.has(key)) {
          const r = await client.request('DELETE', `/reference_data/maps/${enc(e.name)}/${enc(key)}`)
          if (!r.ok && r.status !== 404) failures.push(`restore ${e.name}: remove "${key}": ${qradarErrorMessage(r)}`)
        }
      }
      restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back reference maps: ${deleted} deleted, ${restored} restored` }
}
