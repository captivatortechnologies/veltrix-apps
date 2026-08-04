import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, orgPath, secPolicyDraftPath, basicAuthHeader, getJson } from '../../lib/illumioApi'
import { extractEnforcementBoundarySpecs, buildBoundaryBody, labelIdentity, type Resolvers } from './_shared'

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
interface LiveBoundary extends LiveNamed {
  enabled?: boolean
  providers?: unknown
  consumers?: unknown
  ingress_services?: unknown
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${[...v].map(stableStringify).sort().join(',')}]`
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((k) => `${k}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** Drop server-added fields (e.g. an embedded label's key/value) so only the href is compared. */
function normalizeLiveRefs(raw: unknown): unknown {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const e = entry as Record<string, unknown>
    if (e.actors) return { actors: e.actors }
    if (e.label && typeof e.label === 'object') return { label: { href: (e.label as Record<string, unknown>).href } }
    if (e.ip_list && typeof e.ip_list === 'object') return { ip_list: { href: (e.ip_list as Record<string, unknown>).href } }
    return e
  })
}

function normalizeLiveServices(raw: unknown): unknown {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const e = entry as Record<string, unknown>
    return e.href ? { href: e.href } : e
  })
}

/** See config-types/ip-lists/driftDetect.ts — compares against draft, which this app keeps in lockstep with active via provisioning on every deploy. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  const cred = resolveIllumioCredential(ctx.credential)
  if (!base || !cred) return { hasDrift: false, diffs: [] }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const specs = extractEnforcementBoundarySpecs(ctx.deployedConfig).filter((s) => s.name && !s.providersError && !s.consumersError && !s.servicesError)
  const diffs: Diffs = []
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let liveLabels: LiveLabel[]
  let liveIpLists: LiveNamed[]
  let liveServices: LiveNamed[]
  let live: LiveBoundary[]
  try {
    ;[liveLabels, liveIpLists, liveServices, live] = await Promise.all([
      getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${base}${secPolicyDraftPath(settings, 'ip_lists')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${base}${secPolicyDraftPath(settings, 'services')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveBoundary[]>(`${base}${secPolicyDraftPath(settings, 'enforcement_boundaries')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
    ])
  } catch {
    return { hasDrift: false, diffs: [] }
  }

  const resolvers: Resolvers = {
    labelHrefByIdentity: new Map(
      liveLabels.filter((l) => l.key !== undefined && l.value !== undefined && l.href).map((l) => [labelIdentity(l.key!, l.value!), l.href!]),
    ),
    ipListHrefByName: new Map(liveIpLists.filter((l) => l.name && l.href).map((l) => [l.name!.toLowerCase(), l.href!])),
    serviceHrefByName: new Map(liveServices.filter((s) => s.name && s.href).map((s) => [s.name!.toLowerCase(), s.href!])),
  }
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))

  for (const spec of specs) {
    let wantBody: Record<string, unknown>
    try {
      wantBody = buildBoundaryBody(spec, resolvers)
    } catch (err) {
      diffs.push({ field: `${spec.name}.references`, expected: 'resolved', actual: err instanceof Error ? err.message : 'unresolved reference', severity: 'critical' })
      continue
    }

    const l = liveByName.get(spec.name.toLowerCase())
    if (!l) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if ((l.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: spec.enabled, actual: l.enabled ?? true, severity: 'warning' })
    }
    const wantProviders = stableStringify(wantBody.providers)
    const haveProviders = stableStringify(normalizeLiveRefs(l.providers))
    if (wantProviders !== haveProviders) {
      diffs.push({ field: `${spec.name}.providers`, expected: wantProviders, actual: haveProviders, severity: 'critical' })
    }
    const wantConsumers = stableStringify(wantBody.consumers)
    const haveConsumers = stableStringify(normalizeLiveRefs(l.consumers))
    if (wantConsumers !== haveConsumers) {
      diffs.push({ field: `${spec.name}.consumers`, expected: wantConsumers, actual: haveConsumers, severity: 'critical' })
    }
    const wantServices = stableStringify(wantBody.ingress_services)
    const haveServices = stableStringify(normalizeLiveServices(l.ingress_services))
    if (wantServices !== haveServices) {
      diffs.push({ field: `${spec.name}.ingress_services`, expected: wantServices, actual: haveServices, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
