import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { extractSpecs, hostOverrideKey } from './_shared'

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Detect drift between the last-deployed host overrides and live pfSense state, matched by host+domain. Read-only. */
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

  const specs = extractSpecs(items).filter((s) => s.domain && s.ip.length > 0)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await client.listDnsResolverHostOverrides()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const byKey = new Map(live.filter((o) => o.domain !== undefined).map((o) => [hostOverrideKey(o.host ?? '', o.domain), o]))

  for (const spec of specs) {
    const key = hostOverrideKey(spec.host, spec.domain)
    const found = byKey.get(key)
    const label = spec.host ? `${spec.host}.${spec.domain}` : spec.domain

    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    const liveIps = Array.isArray(found.ip) ? found.ip : []
    if (!sameList(liveIps, spec.ip)) {
      diffs.push({ field: `${label}.ip`, expected: spec.ip.join(', '), actual: liveIps.join(', ') || '(none)', severity: 'critical' })
    }
    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
