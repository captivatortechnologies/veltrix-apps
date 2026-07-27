import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractTriggerSubscriptionSpecs, type LiveTriggerSubscription } from './validate'

const BASE = '/beta/trigger-subscriptions'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractTriggerSubscriptionSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveTriggerSubscription>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

  // httpConfig is secret-bearing and masked on GET, so drift tracks scalars only.
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.triggerId ?? '') !== spec.triggerId) {
      diffs.push({ field: `${spec.name}.triggerId`, expected: spec.triggerId, actual: live.triggerId ?? '', severity: 'critical' })
    }
    if (spec.type && live.type && live.type !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: live.type, severity: 'critical' })
    }
    if ((live.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(live.enabled ?? true), severity: 'warning' })
    }
    if (((live.filter ?? '') as string) !== spec.filter) {
      diffs.push({ field: `${spec.name}.filter`, expected: spec.filter, actual: live.filter ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
