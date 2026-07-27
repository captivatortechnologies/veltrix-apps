import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractWorkflowSpecs, type LiveWorkflow } from './validate'

const BASE = '/v3/workflows'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractWorkflowSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveWorkflow>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((w) => w.name).map((w) => [w.name!.toLowerCase(), w]))

  // The definition/trigger graph is normalized by ISC on save, so drift tracks
  // the stable scalar fields only (presence, owner, enabled, description).
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    if ((live.owner?.id ?? '') !== spec.ownerId) {
      diffs.push({ field: `${spec.name}.owner`, expected: spec.ownerId, actual: live.owner?.id ?? '', severity: 'warning' })
    }
    if ((live.enabled ?? false) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(live.enabled ?? false), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
