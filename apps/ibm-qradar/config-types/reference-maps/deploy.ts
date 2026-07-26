import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  parseJson,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type QRadarClient,
} from '../../lib/qradar'
import { extractReferenceMapSpecs, type LiveReferenceMap, type MapEntry, type ReferenceMapSpec } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  elementType: string
  priorEntries?: MapEntry[]
}

const enc = encodeURIComponent

function mapValues(live: LiveReferenceMap): MapEntry[] {
  const data = live.data ?? {}
  return Object.keys(data).map((key) => ({ key, value: data[key]?.value ?? '' }))
}

async function getMap(client: QRadarClient, name: string) {
  return client.request('GET', `/reference_data/maps/${enc(name)}`, { range: 'items=0-9999' })
}

/** Reconcile a map's entries to exactly the desired set (add/update, remove extra). */
async function reconcileEntries(client: QRadarClient, name: string, desired: MapEntry[], live: MapEntry[], failures: string[]): Promise<void> {
  const liveMap = new Map(live.map((e) => [e.key, e.value]))
  const desiredKeys = new Set(desired.map((e) => e.key))
  for (const e of desired) {
    if (liveMap.get(e.key) !== e.value) {
      // POST key=value adds-or-updates.
      const resp = await client.request('POST', `/reference_data/maps/${enc(name)}?key=${enc(e.key)}&value=${enc(e.value)}`)
      if (!resp.ok) failures.push(`${name}: set "${e.key}": ${qradarErrorMessage(resp)}`)
    }
  }
  for (const e of live) {
    if (!desiredKeys.has(e.key)) {
      const resp = await client.request('DELETE', `/reference_data/maps/${enc(name)}/${enc(e.key)}`)
      if (!resp.ok && resp.status !== 404) failures.push(`${name}: remove "${e.key}": ${qradarErrorMessage(resp)}`)
    }
  }
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const specs = extractReferenceMapSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const getRes = await getMap(client, spec.name)
    if (getRes.ok) {
      const live = parseJson<LiveReferenceMap>(getRes.body)
      const liveType = (live?.element_type ?? '').toUpperCase()
      if (liveType && liveType !== spec.elementType) {
        failures.push(`${spec.name}: exists with element type "${liveType}" — element type is immutable, so rename or delete the existing map first`)
        continue
      }
      const current = live ? mapValues(live) : []
      await reconcileEntries(client, spec.name, spec.entries, current, failures)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, elementType: spec.elementType, priorEntries: current })
    } else if (getRes.status === 404) {
      const createRes = await client.request('POST', `/reference_data/maps?name=${enc(spec.name)}&element_type=${enc(spec.elementType)}`)
      if (!createRes.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(createRes)}`)
        continue
      }
      await reconcileEntries(client, spec.name, spec.entries, [], failures)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, elementType: spec.elementType, priorEntries: [] })
    } else {
      failures.push(`${spec.name}: ${qradarErrorMessage(getRes)}`)
    }
  }

  // Reconcile: delete maps THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('DELETE', `/reference_data/maps/${enc(p.name)}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some reference maps failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} reference map(s)`, rollbackData: { entries } }
}
