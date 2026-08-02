import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, secPolicyDraftPath, basicAuthHeader, getJson } from '../../lib/illumioApi'
import { extractServiceSpecs } from './validate'

type Diffs = DriftResult['diffs']
const LIST_MAX_RESULTS = 10000

interface LiveServicePort {
  port?: number
  to_port?: number
  proto?: number
  icmp_type?: number
  icmp_code?: number
}
interface LiveService {
  href?: string
  name?: string
  service_ports?: LiveServicePort[]
}

function normalizePorts(ports: LiveServicePort[] | undefined): string {
  return (ports ?? [])
    .map((p) => `${p.proto ?? ''}|${p.port ?? ''}|${p.to_port ?? ''}|${p.icmp_type ?? ''}|${p.icmp_code ?? ''}`)
    .sort()
    .join(',')
}

/** See config-types/ip-lists/driftDetect.ts — compares against draft, which this app keeps in lockstep with active via provisioning on every deploy. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  const cred = resolveIllumioCredential(ctx.credential)
  if (!base || !cred) return { hasDrift: false, diffs: [] }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const specs = extractServiceSpecs(ctx.deployedConfig).filter((s) => s.name && !s.servicePortsError)
  const diffs: Diffs = []

  let live: LiveService[]
  try {
    live = await getJson<LiveService[]>(`${base}${secPolicyDraftPath(settings, 'services')}?max_results=${LIST_MAX_RESULTS}`, headers, opts)
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
    const want = normalizePorts(
      spec.servicePorts.map((p) => ({ proto: p.proto, port: p.port, to_port: p.toPort, icmp_type: p.icmpType, icmp_code: p.icmpCode })),
    )
    const have = normalizePorts(l.service_ports)
    if (want !== have) {
      diffs.push({ field: `${spec.name}.service_ports`, expected: want, actual: have, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
