import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  readIllumioSettings,
  resolveIllumioCredential,
  buildIllumioBaseUrl,
  orgPath,
  secPolicyDraftPath,
  basicAuthHeader,
  getJson,
  sendJson,
  provisionChanges,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/illumioApi'
import { extractVirtualServiceSpecs, type VirtualServiceSpec } from './validate'

/** See config-types/labels/deploy.ts — same generous cap, same reasoning. */
const LIST_MAX_RESULTS = 10000

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  /** The virtual service's href in the PCE draft (e.g. "/orgs/1/sec_policy/draft/virtual_services/18"). */
  href: string
  prior?: Record<string, unknown>
}

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
  description?: string
  apply_to?: string
  service?: { href?: string }
  service_ports?: unknown
  labels?: Array<{ href?: string }>
  ip_overrides?: string[]
  external_data_set?: string
  external_data_reference?: string
}

function labelIdentity(key: string, value: string): string {
  return `${key} ${value}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function buildBody(spec: VirtualServiceSpec, serviceHref: string | null, labelHrefs: Array<{ href: string }>): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, apply_to: spec.applyTo }
  if (spec.description) body.description = spec.description
  if (serviceHref) {
    body.service = { href: serviceHref }
  } else if (spec.servicePorts.length) {
    body.service_ports = spec.servicePorts.map((p) => ({
      proto: p.proto,
      ...(p.port !== undefined ? { port: p.port } : {}),
      ...(p.toPort !== undefined ? { to_port: p.toPort } : {}),
    }))
  }
  if (labelHrefs.length) body.labels = labelHrefs
  if (spec.ipOverrides.length) body.ip_overrides = spec.ipOverrides
  if (spec.externalDataSet) body.external_data_set = spec.externalDataSet
  if (spec.externalDataReference) body.external_data_reference = spec.externalDataReference
  return body
}

function snapshotLive(live: LiveVirtualService): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name, apply_to: live.apply_to }
  for (const k of ['description', 'service', 'service_ports', 'labels', 'ip_overrides', 'external_data_set', 'external_data_reference'] as const) {
    if (live[k] !== undefined) body[k] = live[k]
  }
  return body
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Deploy Illumio virtual services (DRAFT → PROVISION) — same shape as
 * ip-lists, plus resolving an optional Service-name reference and every
 * member label ref. FAILS CLOSED: a virtual service referencing a service or
 * label that doesn't exist is skipped entirely.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) return { success: false, message: 'No PCE host is configured — set the "PCE host" app setting.' }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const listUrl = `${base}${secPolicyDraftPath(settings, 'virtual_services')}`

  const allSpecs = extractVirtualServiceSpecs(ctx.canvas)
  const specs = allSpecs.filter((s) => s.name && !s.servicePortsError && !s.labelsError)
  const failures: string[] = []
  const entries: RollbackEntry[] = []
  const changedHrefs = new Set<string>()

  let liveLabels: LiveLabel[]
  let liveServices: LiveNamed[]
  let live: LiveVirtualService[]
  try {
    ;[liveLabels, liveServices, live] = await Promise.all([
      getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${base}${secPolicyDraftPath(settings, 'services')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveVirtualService[]>(`${listUrl}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
    ])
  } catch (err) {
    return { success: false, message: `Failed to list PCE policy objects: ${errorMessage(err)}` }
  }

  const labelHrefByIdentity = new Map(
    liveLabels.filter((l) => l.key !== undefined && l.value !== undefined && l.href).map((l) => [labelIdentity(l.key!, l.value!), l.href!]),
  )
  const serviceHrefByName = new Map(liveServices.filter((s) => s.name && s.href).map((s) => [s.name!.toLowerCase(), s.href!]))
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))
  const prior = await loadPriorEntries(ctx)

  for (const spec of specs) {
    let serviceHref: string | null = null
    let labelHrefs: Array<{ href: string }> = []
    try {
      if (spec.serviceName) {
        const href = serviceHrefByName.get(spec.serviceName.toLowerCase())
        if (!href) throw new Error(`references service "${spec.serviceName}" which does not exist in the PCE`)
        serviceHref = href
      }
      labelHrefs = spec.labels.map((l) => {
        const href = labelHrefByIdentity.get(labelIdentity(l.key, l.value))
        if (!href) throw new Error(`references label "${l.key}=${l.value}" which does not exist in the PCE`)
        return { href }
      })
    } catch (err) {
      failures.push(`${spec.name}: ${errorMessage(err)}`)
      continue
    }

    const body = buildBody(spec, serviceHref, labelHrefs)
    const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
    if (liveMatch?.href) {
      try {
        await sendJson('PUT', `${base}${liveMatch.href}`, headers, body, opts)
      } catch (err) {
        failures.push(`${spec.name}: update failed — ${errorMessage(err)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, href: liveMatch.href, prior: snapshotLive(liveMatch) })
      changedHrefs.add(liveMatch.href)
      continue
    }

    try {
      const created = await sendJson<LiveVirtualService>('POST', listUrl, headers, body, opts)
      if (!created?.href) {
        failures.push(`${spec.name}: create succeeded but the PCE returned no href`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, href: created.href })
      changedHrefs.add(created.href)
    } catch (err) {
      failures.push(`${spec.name}: create failed — ${errorMessage(err)}`)
    }
  }

  const allCurrentNames = new Set(allSpecs.filter((s) => s.name).map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (p.existed || !p.href) continue
    if (allCurrentNames.has(p.name.toLowerCase())) continue
    try {
      await sendJson('DELETE', `${base}${p.href}`, headers, undefined, opts)
      changedHrefs.add(p.href)
    } catch (err) {
      failures.push(`delete ${p.name}: ${errorMessage(err)}`)
    }
  }

  let provisionNote = ''
  if (changedHrefs.size > 0) {
    try {
      await provisionChanges(base, settings, headers, `Veltrix: deploy virtual services (${changedHrefs.size} change(s))`, {
        virtual_services: [...changedHrefs].map((href) => ({ href })),
      })
      provisionNote = `; provisioned ${changedHrefs.size} change(s)`
    } catch (err) {
      failures.push(`provision failed: ${errorMessage(err)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some virtual services failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} virtual service(s)${provisionNote}`, rollbackData: { entries } }
}
