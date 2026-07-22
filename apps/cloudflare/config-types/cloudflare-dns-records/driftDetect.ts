import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { listDnsRecords } from './deploy'
import { dnsRecordKey, extractDnsRecordSpecs, type LiveDnsRecord } from './validate'

/**
 * Detect drift between the deployed DNS configuration and the live zone. Re-finds
 * each declared record by its (type, name, content) key and diffs the managed
 * fields (ttl, proxied, priority); a missing record is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDnsRecordSpecs(ctx.deployedConfig).filter((s) => s.type && s.name && s.content)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listDnsRecords(client)
    const byKey = new Map<string, LiveDnsRecord>(
      live
        .filter((r) => r.type && r.name && r.content)
        .map((r) => [dnsRecordKey({ type: r.type as string, name: r.name as string, content: r.content as string }), r]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const label = `${spec.type} ${spec.name}`
      const found = byKey.get(dnsRecordKey(spec))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      if ((found.ttl ?? 1) !== spec.ttl) {
        diffs.push({ field: `${label}.ttl`, expected: String(spec.ttl), actual: String(found.ttl ?? 1), severity: 'info' })
      }
      if ((spec.type === 'A' || spec.type === 'AAAA' || spec.type === 'CNAME') && (found.proxied ?? false) !== spec.proxied) {
        diffs.push({ field: `${label}.proxied`, expected: String(spec.proxied), actual: String(found.proxied ?? false), severity: 'warning' })
      }
      if (spec.priority !== undefined && found.priority !== spec.priority) {
        diffs.push({ field: `${label}.priority`, expected: String(spec.priority), actual: String(found.priority ?? 'not set'), severity: 'warning' })
      }
      // Attribute every diff this record produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), { targetId: found.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
