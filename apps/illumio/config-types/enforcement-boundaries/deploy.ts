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
import { extractEnforcementBoundarySpecs, buildBoundaryBody, snapshotLiveBoundary, labelIdentity, type Resolvers } from './_shared'

/** See config-types/labels/deploy.ts — same generous cap, same reasoning. */
const LIST_MAX_RESULTS = 10000

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  /** The boundary's href in the PCE draft (e.g. "/orgs/1/sec_policy/draft/enforcement_boundaries/18"). */
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
 * Deploy Illumio enforcement boundaries (DRAFT → PROVISION) — same shape as
 * ip-lists, plus resolving every provider/consumer/service reference. FAILS
 * CLOSED: a boundary referencing a label/IP list/service that doesn't exist
 * is skipped entirely — a deny-by-default boundary that silently applies to
 * the wrong scope is worse than one that doesn't apply at all.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) return { success: false, message: 'No PCE host is configured — set the "PCE host" app setting.' }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const listUrl = `${base}${secPolicyDraftPath(settings, 'enforcement_boundaries')}`

  const allSpecs = extractEnforcementBoundarySpecs(ctx.canvas)
  const specs = allSpecs.filter((s) => s.name && !s.providersError && !s.consumersError && !s.servicesError)
  const failures: string[] = []
  const entries: RollbackEntry[] = []
  const changedHrefs = new Set<string>()

  let liveLabels: LiveLabel[]
  let liveIpLists: LiveNamed[]
  let liveServices: LiveNamed[]
  let live: LiveNamed[]
  try {
    ;[liveLabels, liveIpLists, liveServices, live] = await Promise.all([
      getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${base}${secPolicyDraftPath(settings, 'ip_lists')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${base}${secPolicyDraftPath(settings, 'services')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${listUrl}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
    ])
  } catch (err) {
    return { success: false, message: `Failed to list PCE policy objects: ${errorMessage(err)}` }
  }

  const resolvers: Resolvers = {
    labelHrefByIdentity: new Map(
      liveLabels.filter((l) => l.key !== undefined && l.value !== undefined && l.href).map((l) => [labelIdentity(l.key!, l.value!), l.href!]),
    ),
    ipListHrefByName: new Map(liveIpLists.filter((l) => l.name && l.href).map((l) => [l.name!.toLowerCase(), l.href!])),
    serviceHrefByName: new Map(liveServices.filter((s) => s.name && s.href).map((s) => [s.name!.toLowerCase(), s.href!])),
  }
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))
  const prior = await loadPriorEntries(ctx)

  for (const spec of specs) {
    let body: Record<string, unknown>
    try {
      body = buildBoundaryBody(spec, resolvers)
    } catch (err) {
      failures.push(`${spec.name}: ${errorMessage(err)}`)
      continue
    }

    const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
    if (liveMatch?.href) {
      try {
        await sendJson('PUT', `${base}${liveMatch.href}`, headers, body, opts)
      } catch (err) {
        failures.push(`${spec.name}: update failed — ${errorMessage(err)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        href: liveMatch.href,
        prior: snapshotLiveBoundary(liveMatch as unknown as Record<string, unknown>),
      })
      changedHrefs.add(liveMatch.href)
      continue
    }

    try {
      const created = await sendJson<LiveNamed>('POST', listUrl, headers, body, opts)
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
      await provisionChanges(base, settings, headers, `Veltrix: deploy enforcement boundaries (${changedHrefs.size} change(s))`, {
        enforcement_boundaries: [...changedHrefs].map((href) => ({ href })),
      })
      provisionNote = `; provisioned ${changedHrefs.size} change(s)`
    } catch (err) {
      failures.push(`provision failed: ${errorMessage(err)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some enforcement boundaries failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} enforcement boundary(ies)${provisionNote}`, rollbackData: { entries } }
}
