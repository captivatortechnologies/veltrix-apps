import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { extractDataAccessScopeSpecs, type DataAccessScopeSpec, type LiveDataAccessScope, type LiveLabelReference } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the scope existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  prior?: { description: string; allowedRefs: LiveLabelReference[]; deniedRefs: LiveLabelReference[] }
}

const enc = encodeURIComponent
const UPDATE_MASK = 'description,allowedDataAccessLabels,deniedDataAccessLabels'

/** Wrap label ids as DataAccessLabelReference objects (the dataAccessLabel form). */
export function labelRefs(ids: string[]): LiveLabelReference[] {
  return ids.map((id) => ({ dataAccessLabel: id }))
}

export function createBody(spec: DataAccessScopeSpec): Record<string, unknown> {
  return {
    description: spec.description,
    allowAll: spec.allowAll,
    allowedDataAccessLabels: labelRefs(spec.allowedLabels),
    deniedDataAccessLabels: labelRefs(spec.deniedLabels),
  }
}

export function updateBody(spec: DataAccessScopeSpec): Record<string, unknown> {
  return {
    description: spec.description,
    allowedDataAccessLabels: labelRefs(spec.allowedLabels),
    deniedDataAccessLabels: labelRefs(spec.deniedLabels),
  }
}

/** A stable identity string for any DataAccessLabelReference form. */
export function refSig(ref: LiveLabelReference): string {
  if (ref.dataAccessLabel) return `label:${ref.dataAccessLabel}`
  if (ref.logType) return `logType:${ref.logType}`
  if (ref.assetNamespace) return `ns:${ref.assetNamespace}`
  if (ref.ingestionLabel) return `ingest:${ref.ingestionLabel.ingestionLabelKey ?? ''}=${ref.ingestionLabel.ingestionLabelValue ?? ''}`
  return ''
}

/** A comparable, order-independent signature for a set of label references. */
export function refsSignature(refs: LiveLabelReference[]): string {
  return JSON.stringify(refs.map(refSig).filter(Boolean).sort())
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

  const specs = extractDataAccessScopeSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/dataAccessScopes/${enc(spec.name)}`)

    if (getRes.ok) {
      const live = parseJson<LiveDataAccessScope>(getRes.body)
      // allow_all is not an updatable field — treat it as fixed at creation.
      if ((live?.allowAll ?? false) !== spec.allowAll) {
        failures.push(`${spec.name}: "allow all" differs from the live scope and cannot be changed by update — rename or delete the scope to change it`)
        continue
      }
      const priorState = {
        description: live?.description ?? '',
        allowedRefs: live?.allowedDataAccessLabels ?? [],
        deniedRefs: live?.deniedDataAccessLabels ?? [],
      }
      const resp = await client.request('PATCH', `${parent}/dataAccessScopes/${enc(spec.name)}?updateMask=${UPDATE_MASK}`, updateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: priorState })
    } else if (getRes.status === 404) {
      const resp = await client.request('POST', `${parent}/dataAccessScopes?dataAccessScopeId=${enc(spec.name)}`, createBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, prior: { description: '', allowedRefs: [], deniedRefs: [] } })
    } else {
      failures.push(`${spec.name}: ${secopsErrorMessage(getRes)}`)
    }
  }

  // Reconcile: delete scopes THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
      const del = await client.request('DELETE', `${parent}/dataAccessScopes/${enc(p.name)}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${p.name}: ${secopsErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some data access scopes failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} data access scope(s)`, rollbackData: { entries } }
}
