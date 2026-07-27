import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/googlesecops'
import { extractDataAccessLabelSpecs, type DataAccessLabelSpec, type LiveDataAccessLabel } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the label existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  prior?: { udmQuery: string; description: string }
}

const enc = encodeURIComponent

export function labelBody(spec: DataAccessLabelSpec): Record<string, unknown> {
  return { udmQuery: spec.udmQuery, description: spec.description }
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

  const specs = extractDataAccessLabelSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/dataAccessLabels/${enc(spec.name)}`)

    if (getRes.ok) {
      const live = parseJson<LiveDataAccessLabel>(getRes.body)
      const priorState = { udmQuery: live?.udmQuery ?? '', description: live?.description ?? '' }
      // Only the description and definition (udmQuery) fields are updatable.
      const resp = await client.request(
        'PATCH',
        `${parent}/dataAccessLabels/${enc(spec.name)}?updateMask=udmQuery,description`,
        labelBody(spec)
      )
      if (!resp.ok) {
        failures.push(`${spec.name}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: priorState })
    } else if (getRes.status === 404) {
      const resp = await client.request('POST', `${parent}/dataAccessLabels?dataAccessLabelId=${enc(spec.name)}`, labelBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, prior: { udmQuery: '', description: '' } })
    } else {
      failures.push(`${spec.name}: ${secopsErrorMessage(getRes)}`)
    }
  }

  // Reconcile: delete labels THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
      const del = await client.request('DELETE', `${parent}/dataAccessLabels/${enc(p.name)}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${p.name}: ${secopsErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some data access labels failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} data access label(s)`, rollbackData: { entries } }
}
