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
import { extractReferenceSetSpecs, type LiveReferenceSet, type ReferenceSetSpec } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the set existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  elementType: string
  /** the set's values before this deploy, so rollback can restore them. */
  priorValues?: string[]
}

/** Reconcile a set's values to exactly the desired set (add missing, remove extra). */
async function reconcileValues(client: QRadarClient, name: string, desired: string[], live: string[], failures: string[]): Promise<void> {
  const liveSet = new Set(live)
  const desiredSet = new Set(desired)
  for (const v of desired) {
    if (!liveSet.has(v)) {
      const resp = await client.addValue(name, v)
      if (!resp.ok) failures.push(`${name}: add "${v}": ${qradarErrorMessage(resp)}`)
    }
  }
  for (const v of live) {
    if (!desiredSet.has(v)) {
      const resp = await client.deleteValue(name, v)
      if (!resp.ok && resp.status !== 404) failures.push(`${name}: remove "${v}": ${qradarErrorMessage(resp)}`)
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

function liveValues(live: LiveReferenceSet): string[] {
  return (live.data ?? []).map((d) => d.value ?? '').filter((v) => v.length > 0)
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const specs = extractReferenceSetSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const getRes = await client.getSet(spec.name)

    if (getRes.ok) {
      const live = parseJson<LiveReferenceSet>(getRes.body)
      const liveType = (live?.element_type ?? '').toUpperCase()
      if (liveType && liveType !== spec.elementType) {
        failures.push(`${spec.name}: exists with element type "${liveType}" — element type is immutable, so rename or delete the existing set first`)
        continue
      }
      const current = live ? liveValues(live) : []
      await reconcileValues(client, spec.name, spec.values, current, failures)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, elementType: spec.elementType, priorValues: current })
    } else if (getRes.status === 404) {
      const createRes = await client.createSet(spec.name, spec.elementType)
      if (!createRes.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(createRes)}`)
        continue
      }
      await reconcileValues(client, spec.name, spec.values, [], failures)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, elementType: spec.elementType, priorValues: [] })
    } else {
      failures.push(`${spec.name}: ${qradarErrorMessage(getRes)}`)
    }
  }

  // Reconcile: delete sets THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.deleteSet(p.name)
      // 202 = async delete accepted; 404 = already gone.
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some reference sets failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} reference set(s)`, rollbackData: { entries } }
}
