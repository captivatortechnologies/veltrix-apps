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
import { listLogSourceGroups } from '../../lib/lookups'
import { extractLogSourceGroupSpecs, type LiveLogSourceGroup, type LogSourceGroupSpec } from './validate'

const PATH = '/config/event_sources/log_source_management/log_source_groups'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: number
}

export async function listGroups(client: QRadarClient): Promise<LiveLogSourceGroup[]> {
  return listLogSourceGroups(client)
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

  const specs = extractLogSourceGroupSpecs(ctx.canvas).filter((s) => s.name)
  await loadPriorEntries(ctx)

  const live = await listGroups(client)
  // resolvedByName tracks both live groups AND groups created during this run,
  // so a declared group's parent can be another group declared in the same canvas.
  const resolvedByName = new Map<string, number>()
  for (const g of live) if (g.name && typeof g.id === 'number') resolvedByName.set(g.name.toLowerCase(), g.id)

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  let created = 0

  // Worklist: repeat passes until no progress, so parents (whether live or
  // declared earlier/later in the canvas) are always created before children.
  let remaining = [...specs]
  let progressed = true
  while (remaining.length > 0 && progressed) {
    progressed = false
    const next: LogSourceGroupSpec[] = []

    for (const spec of remaining) {
      const nameKey = spec.name.toLowerCase()
      if (resolvedByName.has(nameKey)) {
        // Already exists (live or created earlier in this pass) — nothing to change,
        // the API has no update endpoint.
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: resolvedByName.get(nameKey) })
        progressed = true
        continue
      }

      let parentId: number | undefined
      if (spec.parentName) {
        parentId = resolvedByName.get(spec.parentName.toLowerCase())
        if (parentId === undefined) {
          next.push(spec) // parent not resolved yet — retry next pass
          continue
        }
      }

      const body: Record<string, unknown> = { name: spec.name }
      if (spec.description) body.description = spec.description
      if (parentId !== undefined) body.parent_id = parentId

      const resp = await client.request('POST', PATH, { body })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        progressed = true // stop retrying this one; do not loop forever on a hard failure
        continue
      }
      const madeRaw = parseJson<LiveLogSourceGroup>(resp.body)
      const made = madeRaw && typeof madeRaw.id === 'number' ? madeRaw.id : undefined
      if (made !== undefined) resolvedByName.set(nameKey, made)
      created++
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: made })
      progressed = true
    }

    remaining = next
  }

  // Anything left after the loop stalled has an unresolvable parent (declared
  // name not found live or in this canvas).
  for (const spec of remaining) {
    failures.push(`${spec.name}: unknown parent group "${spec.parentName}"`)
  }

  // NOTE: the API exposes no update or delete for log source groups, so there
  // is no reconcile-delete — groups this app created but no longer declares
  // remain in QRadar.

  if (failures.length) {
    return { success: false, message: `Some log source groups failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Ensured ${entries.length} log source group(s) (${created} created)`, rollbackData: { entries } }
}
