import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, orgPath, secPolicyDraftPath, basicAuthHeader, getJson } from '../../lib/illumioApi'
import { extractVirtualServiceSpecs } from './validate'

type Diffs = DriftResult['diffs']
const LIST_MAX_RESULTS = 10000

interface LiveLabel {
  href?: string
  key?: string
  value?: string
}
interface LiveNamed {
  href?: string
  name?: string
}
interface LiveVirtualService extends LiveNamed {
  apply_to?: string
  service?: { href?: string }
  service_ports?: Array<{ proto?: number; port?: number; to_port?: number }>
  labels?: Array<{ href?: string }>
  ip_overrides?: string[]
}

function labelIdentity(key: string, value: string): string {
  return `${key} ${value}`
}

function normalizePorts(ports: Array<{ proto?: number; port?: number; to_port?: number }> | undefined): string {
  return (ports ?? []).map((p) => `${p.proto ?? ''}|${p.port ?? ''}|${p.to_port ?? ''}`).sort().join(',')
}

function normalizeHrefs(hrefs: Array<{ href?: string }> | undefined): string {
  return (hrefs ?? []).map((h) => h.href ?? '').filter(Boolean).sort().join(',')
}

/** See config-types/ip-lists/driftDetect.ts — compares against draft, which this app keeps in lockstep with active via provisioning on every deploy. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  const cred = resolveIllumioCredential(ctx.credential)
  if (!base || !cred) return { hasDrift: false, diffs: [] }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const specs = extractVirtualServiceSpecs(ctx.deployedConfig).filter((s) => s.name && !s.servicePortsError && !s.labelsError)
  const diffs: Diffs = []
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let liveLabels: LiveLabel[]
  let liveServices: LiveNamed[]
  let live: LiveVirtualService[]
  try {
    ;[liveLabels, liveServices, live] = await Promise.all([
      getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${base}${secPolicyDraftPath(settings, 'services')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveVirtualService[]>(`${base}${secPolicyDraftPath(settings, 'virtual_services')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
    ])
  } catch {
    return { hasDrift: false, diffs: [] }
  }

  const labelHrefByIdentity = new Map(
    liveLabels.filter((l) => l.key !== undefined && l.value !== undefined && l.href).map((l) => [labelIdentity(l.key!, l.value!), l.href!]),
  )
  const serviceHrefByName = new Map(liveServices.filter((s) => s.name && s.href).map((s) => [s.name!.toLowerCase(), s.href!]))
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))

  for (const spec of specs) {
    const l = liveByName.get(spec.name.toLowerCase())
    if (!l) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((l.apply_to ?? '') !== spec.applyTo) {
      diffs.push({ field: `${spec.name}.apply_to`, expected: spec.applyTo, actual: l.apply_to ?? '', severity: 'critical' })
    }

    if (spec.serviceName) {
      const wantHref = serviceHrefByName.get(spec.serviceName.toLowerCase())
      if (!wantHref) {
        diffs.push({ field: `${spec.name}.service`, expected: 'resolved', actual: 'referenced service no longer exists', severity: 'critical' })
      } else if ((l.service?.href ?? '') !== wantHref) {
        diffs.push({ field: `${spec.name}.service`, expected: wantHref, actual: l.service?.href ?? '', severity: 'critical' })
      }
    } else {
      const want = normalizePorts(spec.servicePorts.map((p) => ({ proto: p.proto, port: p.port, to_port: p.toPort })))
      const have = normalizePorts(l.service_ports)
      if (want !== have) {
        diffs.push({ field: `${spec.name}.service_ports`, expected: want, actual: have, severity: 'critical' })
      }
    }

    let wantLabelHrefs: string[]
    try {
      wantLabelHrefs = spec.labels.map((ref) => {
        const href = labelHrefByIdentity.get(labelIdentity(ref.key, ref.value))
        if (!href) throw new Error('unresolved')
        return href
      })
    } catch {
      diffs.push({ field: `${spec.name}.labels`, expected: 'resolved', actual: 'a referenced label no longer exists', severity: 'critical' })
      continue
    }
    const wantLabels = [...wantLabelHrefs].sort().join(',')
    const haveLabels = normalizeHrefs(l.labels)
    if (wantLabels !== haveLabels) {
      diffs.push({ field: `${spec.name}.labels`, expected: wantLabels, actual: haveLabels, severity: 'warning' })
    }

    const wantIpOverrides = [...spec.ipOverrides].sort().join(',')
    const haveIpOverrides = [...(l.ip_overrides ?? [])].sort().join(',')
    if (wantIpOverrides !== haveIpOverrides) {
      diffs.push({ field: `${spec.name}.ip_overrides`, expected: wantIpOverrides, actual: haveIpOverrides, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
