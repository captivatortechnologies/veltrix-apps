import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { domainOverrideKey, extractSpecs } from './_shared'

/** Detect drift between the last-deployed domain overrides and live pfSense state, matched by domain. Read-only. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const auth = await client.authenticate()
  if (auth.error) return { hasDrift: false, diffs }

  const specs = extractSpecs(items).filter((s) => s.domain && s.ip)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await client.listDnsResolverDomainOverrides()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const byDomain = new Map(live.filter((o) => o.domain).map((o) => [domainOverrideKey(o.domain), o]))

  for (const spec of specs) {
    const found = byDomain.get(domainOverrideKey(spec.domain))
    const label = spec.domain

    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if (found.ip !== spec.ip) diffs.push({ field: `${label}.ip`, expected: spec.ip, actual: found.ip, severity: 'critical' })
    if (Boolean(found.forward_tls_upstream) !== spec.forwardTlsUpstream) {
      diffs.push({ field: `${label}.forward_tls_upstream`, expected: String(spec.forwardTlsUpstream), actual: String(Boolean(found.forward_tls_upstream)), severity: 'warning' })
    }
    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
