import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { liveTagNames, sameStringSet } from '../lib/checkpointShared'
import { listAllServices } from './deploy'
import { extractServiceSpecs, serviceKey, type LiveService, type ServiceProtocol } from './validate'

/**
 * Detect drift between the deployed service-object configuration and the
 * live management database. Re-finds each declared service by name WITHIN
 * its declared protocol's namespace and diffs the managed fields: a missing
 * service or a changed port is critical drift (it changes what traffic the
 * object matches); a changed source port, comment, color or tag set is a
 * warning. Read-only — logs out without publishing or discarding.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractServiceSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const login = await client.login()
  if (login.error) return { hasDrift: false, diffs: [] }

  try {
    const liveByProtocol = new Map<ServiceProtocol, Map<string, LiveService>>()
    for (const protocol of ['tcp', 'udp'] as const) {
      if (!specs.some((s) => s.protocol === protocol)) continue
      const live = await listAllServices(client, protocol)
      liveByProtocol.set(protocol, new Map(live.filter((s) => s.name).map((s) => [serviceKey(s.name as string), s])))
    }

    for (const spec of specs) {
      const found = liveByProtocol.get(spec.protocol)?.get(serviceKey(spec.name))
      const label = `${spec.name} (${spec.protocol})`

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const livePort = found.port != null ? String(found.port) : ''
      if (livePort !== spec.port) {
        diffs.push({ field: `${label}.port`, expected: spec.port, actual: livePort || '(none)', severity: 'critical' })
      }
      const liveSourcePort = found['source-port'] != null ? String(found['source-port']) : ''
      if (spec.sourcePort || liveSourcePort) {
        if (liveSourcePort !== spec.sourcePort) {
          diffs.push({
            field: `${label}.sourcePort`,
            expected: spec.sourcePort || '(none)',
            actual: liveSourcePort || '(none)',
            severity: 'warning',
          })
        }
      }
      if (spec.comments || found.comments) {
        const liveComments = found.comments ?? ''
        if (liveComments !== spec.comments) {
          diffs.push({ field: `${label}.comments`, expected: spec.comments, actual: liveComments, severity: 'warning' })
        }
      }
      if (spec.color && found.color && found.color !== spec.color) {
        diffs.push({ field: `${label}.color`, expected: spec.color, actual: found.color, severity: 'warning' })
      }
      const liveTags = liveTagNames(found.tags)
      if (!sameStringSet(liveTags, spec.tags)) {
        diffs.push({
          field: `${label}.tags`,
          expected: spec.tags.join(', ') || '(none)',
          actual: liveTags.join(', ') || '(none)',
          severity: 'warning',
        })
      }
    }
  } catch {
    diffs.push({ field: 'checkpoint', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
