import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { indexByLowerName, listEventRetentionBuckets, listFlowRetentionBuckets } from '../../lib/lookups'
import { extractArielCopyProfileSpecs } from './validate'
import { listProfiles } from './deploy'

type Diffs = DriftResult['diffs']

function sortedIds(ids: number[]): string {
  return JSON.stringify([...ids].sort((a, b) => a - b))
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractArielCopyProfileSpecs(ctx.deployedConfig).filter((s) => s.name && s.hostId)
  const [eventBuckets, flowBuckets, live] = await Promise.all([
    listEventRetentionBuckets(client),
    listFlowRetentionBuckets(client),
    listProfiles(client),
  ])
  const eventBucketByName = indexByLowerName(eventBuckets)
  const flowBucketByName = indexByLowerName(flowBuckets)
  const byHostId = new Map(live.filter((p) => typeof p.host_id === 'number').map((p) => [p.host_id as number, p]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const profile = byHostId.get(spec.hostId)
    if (!profile) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((profile.destination_host_ip ?? '') !== spec.destinationHostIp) {
      diffs.push({ field: `${spec.name}.destinationHostIp`, expected: spec.destinationHostIp, actual: profile.destination_host_ip ?? '', severity: 'critical' })
    }
    if ((profile.enabled ?? false) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(profile.enabled ?? false), severity: 'warning' })
    }
    if ((profile.destination_port ?? undefined) !== spec.destinationPort) {
      diffs.push({ field: `${spec.name}.destinationPort`, expected: String(spec.destinationPort ?? ''), actual: String(profile.destination_port ?? ''), severity: 'warning' })
    }
    if ((profile.frequency ?? undefined) !== spec.frequency) {
      diffs.push({ field: `${spec.name}.frequency`, expected: String(spec.frequency ?? ''), actual: String(profile.frequency ?? ''), severity: 'warning' })
    }
    if ((profile.bandwidth_limit ?? undefined) !== spec.bandwidthLimit) {
      diffs.push({ field: `${spec.name}.bandwidthLimit`, expected: String(spec.bandwidthLimit ?? ''), actual: String(profile.bandwidth_limit ?? ''), severity: 'warning' })
    }

    const expectedEventIds = spec.excludeEventRetentionBucketNames.map((n) => eventBucketByName.get(n.toLowerCase())).filter((id): id is number => id !== undefined)
    if (sortedIds(profile.exclude_event_retention_bucket_ids ?? []) !== sortedIds(expectedEventIds)) {
      diffs.push({ field: `${spec.name}.excludeEventRetentionBucketNames`, expected: spec.excludeEventRetentionBucketNames.join(', '), actual: (profile.exclude_event_retention_bucket_ids ?? []).join(', '), severity: 'warning' })
    }
    const expectedFlowIds = spec.excludeFlowRetentionBucketNames.map((n) => flowBucketByName.get(n.toLowerCase())).filter((id): id is number => id !== undefined)
    if (sortedIds(profile.exclude_flow_retention_bucket_ids ?? []) !== sortedIds(expectedFlowIds)) {
      diffs.push({ field: `${spec.name}.excludeFlowRetentionBucketNames`, expected: spec.excludeFlowRetentionBucketNames.join(', '), actual: (profile.exclude_flow_retention_bucket_ids ?? []).join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
