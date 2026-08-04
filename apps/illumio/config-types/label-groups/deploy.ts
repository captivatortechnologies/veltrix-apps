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
import { extractLabelGroupSpecs, type LabelGroupSpec, type LabelRef } from './validate'

/** See config-types/labels/deploy.ts — same generous cap, same reasoning. */
const LIST_MAX_RESULTS = 10000

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  /** The label group's href in the PCE draft (e.g. "/orgs/1/sec_policy/draft/label_groups/18"). */
  href: string
  prior?: Record<string, unknown>
}

interface LiveLabel {
  href?: string
  key?: string
  value?: string
}
interface LiveLabelGroup {
  href?: string
  name?: string
  description?: string
  key?: string
  labels?: Array<{ href?: string }>
  external_data_set?: string
  external_data_reference?: string
}

function labelIdentity(key: string, value: string): string {
  return `${key} ${value}`
}

/** Resolve every member label ref to its href. Throws — FAIL CLOSED — on the first unresolved label. */
function resolveLabelHrefs(labels: LabelRef[], labelHrefByIdentity: Map<string, string>): Array<{ href: string }> {
  return labels.map((l) => {
    const href = labelHrefByIdentity.get(labelIdentity(l.key, l.value))
    if (!href) throw new Error(`references label "${l.key}=${l.value}" which does not exist in the PCE`)
    return { href }
  })
}

function buildBody(spec: LabelGroupSpec, labelHrefs: Array<{ href: string }>): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, key: spec.key, labels: labelHrefs }
  if (spec.description) body.description = spec.description
  if (spec.externalDataSet) body.external_data_set = spec.externalDataSet
  if (spec.externalDataReference) body.external_data_reference = spec.externalDataReference
  return body
}

function snapshotLive(live: LiveLabelGroup): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name, key: live.key }
  for (const k of ['description', 'labels', 'external_data_set', 'external_data_reference'] as const) {
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
 * Deploy Illumio label groups (DRAFT → PROVISION) — same shape as ip-lists,
 * plus resolving each member label ref (key+value) to an href. FAILS CLOSED:
 * a label group referencing a label that doesn't exist is skipped entirely
 * rather than created with a partial membership.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) return { success: false, message: 'No PCE host is configured — set the "PCE host" app setting.' }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const listUrl = `${base}${secPolicyDraftPath(settings, 'label_groups')}`

  const allSpecs = extractLabelGroupSpecs(ctx.canvas)
  const specs = allSpecs.filter((s) => s.name && s.key && !s.labelsError)
  const failures: string[] = []
  const entries: RollbackEntry[] = []
  const changedHrefs = new Set<string>()

  let liveLabels: LiveLabel[]
  let live: LiveLabelGroup[]
  try {
    ;[liveLabels, live] = await Promise.all([
      getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveLabelGroup[]>(`${listUrl}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
    ])
  } catch (err) {
    return { success: false, message: `Failed to list PCE policy objects: ${errorMessage(err)}` }
  }
  const labelHrefByIdentity = new Map(
    liveLabels.filter((l) => l.key !== undefined && l.value !== undefined && l.href).map((l) => [labelIdentity(l.key!, l.value!), l.href!]),
  )
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))
  const prior = await loadPriorEntries(ctx)

  for (const spec of specs) {
    let labelHrefs: Array<{ href: string }>
    try {
      labelHrefs = resolveLabelHrefs(spec.labels, labelHrefByIdentity)
    } catch (err) {
      failures.push(`${spec.name}: ${errorMessage(err)}`)
      continue
    }

    const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
    if (liveMatch?.href) {
      try {
        await sendJson('PUT', `${base}${liveMatch.href}`, headers, buildBody(spec, labelHrefs), opts)
      } catch (err) {
        failures.push(`${spec.name}: update failed — ${errorMessage(err)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, href: liveMatch.href, prior: snapshotLive(liveMatch) })
      changedHrefs.add(liveMatch.href)
      continue
    }

    try {
      const created = await sendJson<LiveLabelGroup>('POST', listUrl, headers, buildBody(spec, labelHrefs), opts)
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
      await provisionChanges(base, settings, headers, `Veltrix: deploy label groups (${changedHrefs.size} change(s))`, {
        label_groups: [...changedHrefs].map((href) => ({ href })),
      })
      provisionNote = `; provisioned ${changedHrefs.size} change(s)`
    } catch (err) {
      failures.push(`provision failed: ${errorMessage(err)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some label groups failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} label group(s)${provisionNote}`, rollbackData: { entries } }
}
