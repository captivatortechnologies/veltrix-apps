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
import type { LiveMapOfSets } from './validate'

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
      const resp = await client.request('DELETE', `/reference_data/map_of_sets/${enc(e.name)}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${e.name}: ${qradarErrorMessage(resp)}`)
      else deleted++
    } else {
      const prior = new Set((e.priorPairs ?? []).map(([k, v]) => `${k} ${v}`))
      const getRes = await client.request('GET', `/reference_data/map_of_sets/${enc(e.name)}`, { range: 'items=0-9999' })
      if (!getRes.ok) {
        failures.push(`restore ${e.name}: ${qradarErrorMessage(getRes)}`)
        continue
      }
      const live = parseJson<LiveMapOfSets>(getRes.body)
      const current: Array<[string, string]> = []
      const map = live?.data ?? {}
      for (const key of Object.keys(map)) for (const cell of map[key] ?? []) if (cell.value) current.push([key, cell.value])

      for (const pair of prior) {
        if (!current.some(([k, v]) => `${k} ${v}` === pair)) {
          const [key, value] = pair.split(' ')
          const r = await client.request('POST', `/reference_data/map_of_sets/${enc(e.name)}?key=${enc(key)}&value=${enc(value)}`)
          if (!r.ok) failures.push(`restore ${e.name}: add "${key}"="${value}": ${qradarErrorMessage(r)}`)
        }
      }
      for (const [key, value] of current) {
        if (!prior.has(`${key} ${value}`)) {
          const r = await client.request('DELETE', `/reference_data/map_of_sets/${enc(e.name)}/${enc(key)}/${enc(value)}`)
          if (!r.ok && r.status !== 404) failures.push(`restore ${e.name}: remove "${key}"="${value}": ${qradarErrorMessage(r)}`)
        }
      }
      restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back map-of-sets: ${deleted} deleted, ${restored} restored` }
}
