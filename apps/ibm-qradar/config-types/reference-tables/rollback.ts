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
import { liveCells } from './deploy'
import type { LiveReferenceTable } from './validate'

const enc = encodeURIComponent
const SEP = ' '

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
      const resp = await client.request('DELETE', `/reference_data/tables/${enc(e.name)}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${e.name}: ${qradarErrorMessage(resp)}`)
      else deleted++
    } else {
      const prior = new Map((e.priorCells ?? []).map((c) => [`${c.outerKey}${SEP}${c.innerKey}`, c.value]))
      const getRes = await client.request('GET', `/reference_data/tables/${enc(e.name)}`, { range: 'items=0-9999' })
      if (!getRes.ok) {
        failures.push(`restore ${e.name}: ${qradarErrorMessage(getRes)}`)
        continue
      }
      const live = parseJson<LiveReferenceTable>(getRes.body)
      const current = live ? liveCells(live) : []
      for (const [id, value] of prior) {
        const [outerKey, innerKey] = id.split(SEP)
        if (current.find((c) => `${c.outerKey}${SEP}${c.innerKey}` === id)?.value !== value) {
          const r = await client.request('POST', `/reference_data/tables/${enc(e.name)}?outer_key=${enc(outerKey)}&inner_key=${enc(innerKey)}&value=${enc(value)}`)
          if (!r.ok) failures.push(`restore ${e.name}: set "${outerKey}|${innerKey}": ${qradarErrorMessage(r)}`)
        }
      }
      for (const c of current) {
        if (!prior.has(`${c.outerKey}${SEP}${c.innerKey}`)) {
          const r = await client.request('DELETE', `/reference_data/tables/${enc(e.name)}/${enc(c.outerKey)}/${enc(c.innerKey)}`)
          if (!r.ok && r.status !== 404) failures.push(`restore ${e.name}: remove "${c.outerKey}|${c.innerKey}": ${qradarErrorMessage(r)}`)
        }
      }
      restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back reference tables: ${deleted} deleted, ${restored} restored` }
}
