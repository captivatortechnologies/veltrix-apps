import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  readIllumioSettings,
  resolveIllumioCredential,
  buildIllumioBaseUrl,
  orgPath,
  basicAuthHeader,
  getJson,
  sendJson,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/illumioApi'
import { extractLabelSpecs, labelIdentity, type LabelSpec, type LiveLabel } from './validate'

/**
 * Generous page cap for the full reconcile listing. The PCE's own default
 * page size for GET /orgs/{org_id}/labels is not documented in the sources
 * verified for this app (illumio-py / Terraform provider) — pass an explicit,
 * large max_results to avoid truncating an org with many labels rather than
 * relying on an unverified server default.
 */
const LIST_MAX_RESULTS = 10000

export interface RollbackEntry {
  itemId?: string
  key: string
  value: string
  /** Whether this (key, value) existed in the PCE before THIS deploy. */
  existed: boolean
  /** The label's href in the PCE (e.g. "/orgs/1/labels/18") — used to update/delete it precisely. */
  href: string
  /** Metadata captured before an update, so rollback can restore it. Unset when created. */
  priorExternalDataSet?: string
  priorExternalDataReference?: string
}

/** POST body for a new label. `key` is only ever sent on create — it is immutable afterwards. */
export function buildCreateBody(spec: LabelSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { key: spec.key, value: spec.value }
  if (spec.externalDataSet) body.external_data_set = spec.externalDataSet
  if (spec.externalDataReference) body.external_data_reference = spec.externalDataReference
  return body
}

/** PUT body to sync an existing label's mutable fields (key is immutable, so never sent here). */
export function buildUpdateBody(spec: LabelSpec): Record<string, unknown> {
  return {
    value: spec.value,
    external_data_set: spec.externalDataSet || '',
    external_data_reference: spec.externalDataReference || '',
  }
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
 * Deploy Illumio labels over the PCE REST API v2:
 *   list:   GET  /orgs/{org_id}/labels               → live (key, value) index
 *   create: POST /orgs/{org_id}/labels                { key, value, external_data_* }
 *   update: PUT  {href}                                { value, external_data_* } (key immutable)
 *   delete: DELETE {href}                              (reconcile-only, for labels this app created)
 *
 * Identity is the (key, value) pair — value alone is not unique across
 * dimensions, so labels are matched on the pair, never on a generated id.
 * rollbackData records each declared label's href + whether it pre-existed, so
 * rollback can restore prior metadata or delete what this deploy created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) return { success: false, message: 'No PCE host is configured — set the "PCE host" app setting.' }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const labelsUrl = `${base}${orgPath(settings, 'labels')}`

  const specs = extractLabelSpecs(ctx.canvas).filter((s) => s.key && s.value)
  const failures: string[] = []
  const entries: RollbackEntry[] = []

  let live: LiveLabel[]
  try {
    live = await getJson<LiveLabel[]>(`${labelsUrl}?max_results=${LIST_MAX_RESULTS}`, headers, opts)
  } catch (err) {
    return { success: false, message: `Failed to list PCE labels: ${errorMessage(err)}` }
  }
  const liveByIdentity = new Map<string, LiveLabel>()
  for (const l of live) {
    if (l.key !== undefined && l.value !== undefined) liveByIdentity.set(labelIdentity(l.key, l.value), l)
  }

  const prior = await loadPriorEntries(ctx)

  for (const spec of specs) {
    const identity = labelIdentity(spec.key, spec.value)
    const liveMatch = liveByIdentity.get(identity) ?? null

    if (liveMatch?.href) {
      const priorExternalDataSet = liveMatch.external_data_set ?? ''
      const priorExternalDataReference = liveMatch.external_data_reference ?? ''
      const metadataChanged =
        (spec.externalDataSet || '') !== priorExternalDataSet ||
        (spec.externalDataReference || '') !== priorExternalDataReference

      if (metadataChanged) {
        try {
          await sendJson('PUT', `${base}${liveMatch.href}`, headers, buildUpdateBody(spec), opts)
        } catch (err) {
          failures.push(`${identity}: update failed — ${errorMessage(err)}`)
          continue
        }
      }
      entries.push({
        itemId: spec.itemId,
        key: spec.key,
        value: spec.value,
        existed: true,
        href: liveMatch.href,
        priorExternalDataSet,
        priorExternalDataReference,
      })
      continue
    }

    try {
      const created = await sendJson<LiveLabel>('POST', labelsUrl, headers, buildCreateBody(spec), opts)
      if (!created?.href) {
        failures.push(`${identity}: create succeeded but the PCE returned no href`)
        continue
      }
      entries.push({ itemId: spec.itemId, key: spec.key, value: spec.value, existed: false, href: created.href })
    } catch (err) {
      failures.push(`${identity}: create failed — ${errorMessage(err)}`)
    }
  }

  // Reconcile: delete labels THIS app created previously but no longer declares.
  // Labels that already existed before we touched them are left alone even when
  // dropped from the canvas — this app never deletes objects it didn't create.
  const declaredIdentities = new Set(specs.map((s) => labelIdentity(s.key, s.value)))
  for (const p of prior) {
    if (p.existed || !p.href) continue
    const identity = labelIdentity(p.key, p.value)
    if (declaredIdentities.has(identity)) continue
    try {
      await sendJson('DELETE', `${base}${p.href}`, headers, undefined, opts)
    } catch (err) {
      failures.push(`delete ${identity}: ${errorMessage(err)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some labels failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} label(s)`, rollbackData: { entries } }
}
