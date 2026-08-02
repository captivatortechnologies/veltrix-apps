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
import { extractIpListSpecs, type IpListSpec } from './validate'

/** See config-types/labels/deploy.ts — same generous cap, same reasoning. */
const LIST_MAX_RESULTS = 10000

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether this name existed in the PCE before THIS deploy. */
  existed: boolean
  /** The IP list's href in the PCE draft (e.g. "/orgs/1/sec_policy/draft/ip_lists/18"). */
  href: string
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

interface LiveIpList {
  href?: string
  name?: string
  description?: string
  ip_ranges?: Array<{ from_ip?: string; to_ip?: string; description?: string; exclusion?: boolean }>
  fqdns?: Array<{ fqdn?: string; description?: string }>
  external_data_set?: string
  external_data_reference?: string
}

function buildBody(spec: IpListSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  if (spec.description) body.description = spec.description
  if (spec.ipRanges.length) {
    body.ip_ranges = spec.ipRanges.map((r) => ({
      from_ip: r.fromIp,
      ...(r.toIp ? { to_ip: r.toIp } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.exclusion ? { exclusion: true } : {}),
    }))
  }
  if (spec.fqdns.length) {
    body.fqdns = spec.fqdns.map((f) => ({ fqdn: f.fqdn, ...(f.description ? { description: f.description } : {}) }))
  }
  if (spec.externalDataSet) body.external_data_set = spec.externalDataSet
  if (spec.externalDataReference) body.external_data_reference = spec.externalDataReference
  return body
}

function snapshotLive(live: LiveIpList): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of ['description', 'ip_ranges', 'fqdns', 'external_data_set', 'external_data_reference'] as const) {
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
 * Deploy Illumio IP lists (DRAFT → PROVISION):
 *   list:      GET  /orgs/{org}/sec_policy/draft/ip_lists     → live name index
 *   create:    POST /orgs/{org}/sec_policy/draft/ip_lists      { name, ip_ranges, fqdns, ... }
 *   update:    PUT  {href}                                     (full replace of the mutable fields)
 *   delete:    DELETE {href}                                   (reconcile-only)
 *   provision: POST /orgs/{org}/sec_policy { update_description, change_subset: { ip_lists: [{href}] } }
 *
 * Every draft write above — create, update AND delete — is provisioned in the
 * same deploy so the change actually takes effect in the active policy; a
 * label is never in this state (labels have no draft/active split), but every
 * sec_policy object does. Identity is the IP list's `name` (name-keyed, like
 * this app's other draft objects); reconcile only deletes IP lists this app
 * created but no longer declares.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) return { success: false, message: 'No PCE host is configured — set the "PCE host" app setting.' }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const listUrl = `${base}${secPolicyDraftPath(settings, 'ip_lists')}`

  const specs = extractIpListSpecs(ctx.canvas).filter((s) => s.name && !s.ipRangesError && !s.fqdnsError)
  const failures: string[] = []
  const entries: RollbackEntry[] = []
  const changedHrefs: string[] = []

  let live: LiveIpList[]
  try {
    live = await getJson<LiveIpList[]>(`${listUrl}?max_results=${LIST_MAX_RESULTS}`, headers, opts)
  } catch (err) {
    return { success: false, message: `Failed to list PCE IP lists: ${errorMessage(err)}` }
  }
  const liveByName = new Map<string, LiveIpList>()
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
      const created = await sendJson<LiveIpList>('POST', listUrl, headers, buildBody(spec), opts)
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

  // Reconcile: delete IP lists THIS app created previously but no longer declares.
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

  // Provision whatever draft changes succeeded so they take effect — even a
  // partial success is worth activating rather than left stranded in draft.
  let provisionNote = ''
  if (changedHrefs.length > 0) {
    try {
      await provisionChanges(base, settings, headers, `Veltrix: deploy IP lists (${changedHrefs.length} change(s))`, {
        ip_lists: changedHrefs.map((href) => ({ href })),
      })
      provisionNote = `; provisioned ${changedHrefs.length} change(s)`
    } catch (err) {
      failures.push(`provision failed: ${errorMessage(err)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some IP lists failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} IP list(s)${provisionNote}`, rollbackData: { entries } }
}
