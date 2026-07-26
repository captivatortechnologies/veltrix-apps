import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { extractReferenceListSpecs, mapSyntaxType, type LiveReferenceList, type ReferenceListSpec } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the list existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  prior?: { description: string; entries: string[] }
}

function buildEntries(values: string[]): Array<{ value: string }> {
  return values.map((value) => ({ value }))
}

export function createBody(spec: ReferenceListSpec): Record<string, unknown> {
  return { description: spec.description, entries: buildEntries(spec.entries), syntaxType: mapSyntaxType(spec.syntax) }
}

export function patchBody(description: string, entries: string[]): Record<string, unknown> {
  return { description, entries: buildEntries(entries) }
}

function liveEntries(live: LiveReferenceList): string[] {
  return (live.entries ?? []).map((e) => e.value ?? '').filter((v) => v.length > 0)
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
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractReferenceListSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/referenceLists/${encodeURIComponent(spec.name)}?view=REFERENCE_LIST_VIEW_FULL`)

    if (getRes.ok) {
      const live = parseJson<LiveReferenceList>(getRes.body)
      const wantSyntax = mapSyntaxType(spec.syntax)
      if (live?.syntaxType && live.syntaxType !== wantSyntax) {
        failures.push(`${spec.name}: exists with a different syntax type (${live.syntaxType}) — syntax is fixed at creation`)
        continue
      }
      const priorState = { description: live?.description ?? '', entries: live ? liveEntries(live) : [] }
      const resp = await client.request(
        'PATCH',
        `${parent}/referenceLists/${encodeURIComponent(spec.name)}?updateMask=entries,description`,
        patchBody(spec.description, spec.entries)
      )
      if (!resp.ok) {
        failures.push(`${spec.name}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: priorState })
    } else if (getRes.status === 404) {
      const resp = await client.request('POST', `${parent}/referenceLists?referenceListId=${encodeURIComponent(spec.name)}`, createBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, prior: { description: '', entries: [] } })
    } else {
      failures.push(`${spec.name}: ${secopsErrorMessage(getRes)}`)
    }
  }

  // Reconcile: reference lists cannot be deleted, so empty the ones this app
  // created but no longer declares (PATCH entries to []).
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('PATCH', `${parent}/referenceLists/${encodeURIComponent(p.name)}?updateMask=entries`, { entries: [] })
      if (!resp.ok && resp.status !== 404) failures.push(`empty ${p.name}: ${secopsErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some reference lists failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} reference list(s)`, rollbackData: { entries } }
}
