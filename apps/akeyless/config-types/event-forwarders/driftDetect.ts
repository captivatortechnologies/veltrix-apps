import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, stableStringify } from '../../lib/akeyless'
import { getEventForwarder, mapLiveToSpec } from './deploy'
import { extractEventForwarderSpecs, type EventForwarderSpec } from './validate'

/** Non-secret fields compared for drift, scoped per type (webhook URLs/passwords/tokens/certs are never diffed). */
function relevantKeys(type: EventForwarderSpec['type']): (keyof EventForwarderSpec)[] {
  const common: (keyof EventForwarderSpec)[] = ['description', 'enable', 'runnerType', 'eventTypes']
  const byType: Record<string, (keyof EventForwarderSpec)[]> = {
    email: ['emailTo', 'overrideUrl', 'includeError'],
    webhook: ['authType', 'username'],
    servicenow: ['serviceNowAuthType', 'clientId', 'userEmail'],
  }
  return [...common, ...(byType[type] ?? [])]
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractEventForwarderSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  for (const spec of specs) {
    let live
    try {
      live = await getEventForwarder(client, spec.name)
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
      continue
    }

    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (live.noti_forwarder_type && live.noti_forwarder_type !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: live.noti_forwarder_type, severity: 'critical' })
      continue
    }

    const liveSpec = mapLiveToSpec(spec, live)
    for (const key of relevantKeys(spec.type)) {
      const expected = stableStringify(spec[key])
      const actual = stableStringify(liveSpec[key])
      if (expected !== actual) {
        diffs.push({
          field: `${spec.name}.${key}`,
          expected: describeValue(spec[key]),
          actual: describeValue(liveSpec[key]),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)'
  if (value === '' || value === undefined || value === null) return '(none)'
  return String(value)
}
