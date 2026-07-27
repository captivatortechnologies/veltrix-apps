import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractB2xUserFlowSpecs, resultingId, type LiveB2xUserFlow } from './validate'

const BASE = '/identity/b2xUserFlows'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractB2xUserFlowSpecs(ctx.deployedConfig).filter((s) => s.id)
  const listed = await client.getAll<LiveB2xUserFlow>(`${BASE}?$select=id`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveIds = new Set(listed.items.filter((f) => f.id).map((f) => f.id!.toLowerCase()))

  const diffs: DriftResult['diffs'] = []
  for (const spec of specs) {
    const id = resultingId(spec.id)
    if (!liveIds.has(id.toLowerCase())) {
      diffs.push({ field: id, expected: 'present', actual: 'absent', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
