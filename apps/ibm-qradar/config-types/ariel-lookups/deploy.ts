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
import { extractArielLookupSpecs, type ArielLookupSpec, type LiveArielLookup, type LookupEntry } from './validate'

const PATH = '/ariel/lookups'
const enc = encodeURIComponent

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  type: string
  priorDefaultValue?: string
  priorEntries?: LookupEntry[]
}

export async function listLookups(client: QRadarClient): Promise<LiveArielLookup[]> {
  const res = await client.request('GET', PATH, { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveArielLookup[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

function entriesOf(live: LiveArielLookup): LookupEntry[] {
  const map = live.map ?? {}
  return Object.keys(map).map((key) => ({ key, value: map[key] ?? '' }))
}

function mapOf(entries: LookupEntry[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const e of entries) map[e.key] = e.value
  return map
}

function sortedPairs(entries: LookupEntry[]): string {
  return JSON.stringify([...entries].map((e) => `${e.key}=${e.value}`).sort())
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

  const specs = extractArielLookupSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)

  const live = await listLookups(client)
  const byName = new Map(live.filter((l) => l.name).map((l) => [String(l.name).toLowerCase(), l]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const existing = byName.get(spec.name.toLowerCase())

    if (existing) {
      const liveType = existing.type ?? ''
      if (liveType && liveType !== spec.type) {
        failures.push(`${spec.name}: exists with field type "${liveType}" — the type is immutable, so rename or delete the existing lookup first`)
        continue
      }
      const priorDefaultValue = existing.default_value ?? ''
      const priorEntries = entriesOf(existing)
      const changed = priorDefaultValue !== spec.defaultValue || sortedPairs(priorEntries) !== sortedPairs(spec.entries)
      if (changed) {
        const resp = await client.request('POST', `${PATH}/${enc(spec.name)}`, {
          body: { default_value: spec.defaultValue, map: mapOf(spec.entries) },
        })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, type: spec.type, priorDefaultValue, priorEntries })
    } else {
      const resp = await client.request('POST', PATH, {
        body: { name: spec.name, type: spec.type, default_value: spec.defaultValue, map: mapOf(spec.entries) },
      })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, type: spec.type, priorDefaultValue: '', priorEntries: [] })
    }
  }

  // Reconcile: delete lookups THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('DELETE', `${PATH}/${enc(p.name)}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some Ariel lookups failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} Ariel lookup(s)`, rollbackData: { entries } }
}
