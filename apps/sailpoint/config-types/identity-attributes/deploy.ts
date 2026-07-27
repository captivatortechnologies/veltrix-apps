import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractIdentityAttributeSpecs, parseJsonArray, type IdentityAttributeSpec, type LiveIdentityAttribute } from './validate'

const BASE = '/beta/identity-attributes'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

export function buildBody(spec: IdentityAttributeSpec, sources: unknown[]): Record<string, unknown> {
  return {
    name: spec.name,
    displayName: spec.displayName,
    standard: false,
    system: false,
    type: spec.type,
    multi: spec.multi,
    searchable: spec.searchable,
    sources,
  }
}

function snapshot(live: LiveIdentityAttribute): Record<string, unknown> {
  return {
    name: live.name,
    displayName: live.displayName ?? '',
    standard: false,
    system: false,
    type: live.type ?? 'string',
    multi: live.multi ?? false,
    searchable: live.searchable ?? false,
    sources: live.sources ?? [],
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
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const specs = extractIdentityAttributeSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveIdentityAttribute>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list identity attributes: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveIdentityAttribute>()
  for (const a of listed.items) {
    if (a.name) liveByName.set(a.name.toLowerCase(), a)
  }

  const prior = await loadPriorEntries(ctx)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const parsed = parseJsonArray(spec.sourcesRaw)
    if (!parsed.ok) {
      failures.push(`${spec.name}: ${parsed.error}`)
      continue
    }
    const live = liveByName.get(spec.name.toLowerCase()) ?? null
    if (live) {
      if (live.standard || live.system) {
        failures.push(`${spec.name}: this is a standard/system identity attribute and cannot be modified`)
        continue
      }
      const resp = await client.put(`${BASE}/${encodeURIComponent(spec.name)}`, buildBody(spec, parsed.value))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshot(live) })
    } else {
      const resp = await client.post(BASE, buildBody(spec, parsed.value))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false })
    }
  }

  // Reconcile: delete identity attributes THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptNames = new Set(entries.map((e) => e.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !keptNames.has(p.name.toLowerCase()) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${encodeURIComponent(p.name)}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some identity attributes failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} identity attribute(s)`, rollbackData: { entries } }
}
