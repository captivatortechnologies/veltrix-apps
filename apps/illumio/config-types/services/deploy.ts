import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  readIllumioSettings,
  resolveIllumioCredential,
  buildIllumioBaseUrl,
  secPolicyDraftPath,
  basicAuthHeader,
  getJson,
  sendJson,
  provisionChanges,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/illumioApi'
import { extractServiceSpecs, type ServiceSpec } from './validate'

/** See config-types/labels/deploy.ts — same generous cap, same reasoning. */
const LIST_MAX_RESULTS = 10000

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  /** The service's href in the PCE draft (e.g. "/orgs/1/sec_policy/draft/services/18"). */
  href: string
  prior?: Record<string, unknown>
}

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
  description?: string
  service_ports?: LiveServicePort[]
  external_data_set?: string
  external_data_reference?: string
}

function buildBody(spec: ServiceSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    service_ports: spec.servicePorts.map((p) => ({
      proto: p.proto,
      ...(p.port !== undefined ? { port: p.port } : {}),
      ...(p.toPort !== undefined ? { to_port: p.toPort } : {}),
      ...(p.icmpType !== undefined ? { icmp_type: p.icmpType } : {}),
      ...(p.icmpCode !== undefined ? { icmp_code: p.icmpCode } : {}),
    })),
  }
  if (spec.description) body.description = spec.description
  if (spec.externalDataSet) body.external_data_set = spec.externalDataSet
  if (spec.externalDataReference) body.external_data_reference = spec.externalDataReference
  return body
}

function snapshotLive(live: LiveService): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of ['description', 'service_ports', 'external_data_set', 'external_data_reference'] as const) {
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Deploy Illumio services (DRAFT → PROVISION) — same shape as ip-lists:
 *   list/create/update/delete against /orgs/{org}/sec_policy/draft/services,
 *   then POST /orgs/{org}/sec_policy { change_subset: { services: [{href}] } }
 *   to provision every href this deploy touched (create, update AND delete).
 * Identity is the service's `name` (name-keyed); reconcile only deletes
 * services this app created but no longer declares.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) return { success: false, message: 'No PCE host is configured — set the "PCE host" app setting.' }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const listUrl = `${base}${secPolicyDraftPath(settings, 'services')}`

  const specs = extractServiceSpecs(ctx.canvas).filter((s) => s.name && !s.servicePortsError && s.servicePorts.length > 0)
  const failures: string[] = []
  const entries: RollbackEntry[] = []
  const changedHrefs: string[] = []

  let live: LiveService[]
  try {
    live = await getJson<LiveService[]>(`${listUrl}?max_results=${LIST_MAX_RESULTS}`, headers, opts)
  } catch (err) {
    return { success: false, message: `Failed to list PCE services: ${errorMessage(err)}` }
  }
  const liveByName = new Map<string, LiveService>()
  for (const l of live) if (l.name) liveByName.set(l.name.toLowerCase(), l)

  const prior = await loadPriorEntries(ctx)

  for (const spec of specs) {
    const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.href) {
      try {
        await sendJson('PUT', `${base}${liveMatch.href}`, headers, buildBody(spec), opts)
      } catch (err) {
        failures.push(`${spec.name}: update failed — ${errorMessage(err)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, href: liveMatch.href, prior: snapshotLive(liveMatch) })
      changedHrefs.push(liveMatch.href)
      continue
    }

    try {
      const created = await sendJson<LiveService>('POST', listUrl, headers, buildBody(spec), opts)
      if (!created?.href) {
        failures.push(`${spec.name}: create succeeded but the PCE returned no href`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, href: created.href })
      changedHrefs.push(created.href)
    } catch (err) {
      failures.push(`${spec.name}: create failed — ${errorMessage(err)}`)
    }
  }

  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (p.existed || !p.href) continue
    if (declaredNames.has(p.name.toLowerCase())) continue
    try {
      await sendJson('DELETE', `${base}${p.href}`, headers, undefined, opts)
      changedHrefs.push(p.href)
    } catch (err) {
      failures.push(`delete ${p.name}: ${errorMessage(err)}`)
    }
  }

  let provisionNote = ''
  if (changedHrefs.length > 0) {
    try {
      await provisionChanges(base, settings, headers, `Veltrix: deploy services (${changedHrefs.length} change(s))`, {
        services: changedHrefs.map((href) => ({ href })),
      })
      provisionNote = `; provisioned ${changedHrefs.length} change(s)`
    } catch (err) {
      failures.push(`provision failed: ${errorMessage(err)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some services failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} service(s)${provisionNote}`, rollbackData: { entries } }
}
