import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, secPolicyDraftPath, basicAuthHeader, getJson } from '../../lib/illumioApi'
import { extractIpListSpecs } from './validate'

type Diffs = DriftResult['diffs']
const LIST_MAX_RESULTS = 10000

interface LiveIpList {
  href?: string
  name?: string
  description?: string
  ip_ranges?: Array<{ from_ip?: string; to_ip?: string; description?: string; exclusion?: boolean }>
  fqdns?: Array<{ fqdn?: string; description?: string }>
  external_data_set?: string
  external_data_reference?: string
}

function normalizeRanges(ranges: Array<{ from_ip?: string; to_ip?: string; exclusion?: boolean }> | undefined): string {
  return (ranges ?? [])
    .map((r) => `${r.from_ip ?? ''}|${r.to_ip ?? ''}|${r.exclusion ? '1' : '0'}`)
    .sort()
    .join(',')
}

function normalizeFqdns(fqdns: Array<{ fqdn?: string }> | undefined): string {
  return (fqdns ?? [])
    .map((f) => f.fqdn ?? '')
    .sort()
    .join(',')
}

/**
 * Compares against the DRAFT collection (the same one deploy writes to), not a
 * separately-fetched active version — this app always provisions immediately
 * after every draft write, so draft and active stay in lockstep under normal
 * operation. Detecting drift introduced by someone provisioning a change
 * behind this app's back (bypassing draft entirely is not possible on the PCE,
 * but a manual UI edit + manual provision would still show up here since it
 * also lands in draft) is out of scope for a from-active comparison.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  const cred = resolveIllumioCredential(ctx.credential)
  if (!base || !cred) return { hasDrift: false, diffs: [] }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const specs = extractIpListSpecs(ctx.deployedConfig).filter((s) => s.name && !s.ipRangesError && !s.fqdnsError)
  const diffs: Diffs = []

  let live: LiveIpList[]
  try {
    live = await getJson<LiveIpList[]>(`${base}${secPolicyDraftPath(settings, 'ip_lists')}?max_results=${LIST_MAX_RESULTS}`, headers, opts)
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))

  for (const spec of specs) {
    const l = liveByName.get(spec.name.toLowerCase())
    if (!l) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const wantRanges = normalizeRanges(spec.ipRanges.map((r) => ({ from_ip: r.fromIp, to_ip: r.toIp, exclusion: r.exclusion })))
    const haveRanges = normalizeRanges(l.ip_ranges)
    if (wantRanges !== haveRanges) {
      diffs.push({ field: `${spec.name}.ip_ranges`, expected: wantRanges, actual: haveRanges, severity: 'critical' })
    }
    const wantFqdns = normalizeFqdns(spec.fqdns.map((f) => ({ fqdn: f.fqdn })))
    const haveFqdns = normalizeFqdns(l.fqdns)
    if (wantFqdns !== haveFqdns) {
      diffs.push({ field: `${spec.name}.fqdns`, expected: wantFqdns, actual: haveFqdns, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
