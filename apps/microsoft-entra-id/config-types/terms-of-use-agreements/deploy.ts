import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  buildTermsExpiration,
  effectiveFileName,
  effectiveLanguage,
  extractTermsOfUseSpecs,
  type LiveTermsOfUse,
  type TermsOfUseSpec,
} from './validate'

const BASE = '/identityGovernance/termsOfUse/agreements'
/** Only the top-level metadata is listed — the PDF is never compared or restored. */
const SELECT =
  '?$select=id,displayName,isViewingBeforeAcceptanceRequired,isPerDeviceAcceptanceRequired,userReacceptRequiredFrequency,termsExpiration'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the agreement existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** Prior PATCH-able metadata, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Body for POST /agreements. Creating REQUIRES at least one file with base64
 * fileData, so the PDF is wrapped in the `files` array (the shape the Graph
 * v1.0 create example uses). All metadata — including the create-only fields
 * (per-device acceptance, re-accept frequency, expiration) — is settable here.
 */
export function buildCreateBody(spec: TermsOfUseSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    displayName: spec.name,
    isViewingBeforeAcceptanceRequired: spec.viewingBeforeAcceptanceRequired,
    isPerDeviceAcceptanceRequired: spec.perDeviceAcceptanceRequired,
    files: [
      {
        fileName: effectiveFileName(spec),
        displayName: spec.name,
        language: effectiveLanguage(spec),
        isDefault: true,
        isMajorVersion: true,
        fileData: { data: spec.fileData },
      },
    ],
  }
  if (spec.reacceptFrequency) body.userReacceptRequiredFrequency = spec.reacceptFrequency
  const termsExpiration = buildTermsExpiration(spec)
  if (termsExpiration) body.termsExpiration = termsExpiration
  return body
}

/**
 * Body for PATCH /agreements/{id}. Graph v1.0 update only supports `displayName`
 * and `isViewingBeforeAcceptanceRequired`; the other metadata and the PDF are
 * create-only, so an update can never change them.
 */
export function buildPatchBody(spec: TermsOfUseSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    isViewingBeforeAcceptanceRequired: spec.viewingBeforeAcceptanceRequired,
  }
}

/** Snapshot only the PATCH-able fields — that is all rollback can restore. */
function snapshotLive(live: LiveTermsOfUse): Record<string, unknown> {
  return {
    displayName: live.displayName,
    isViewingBeforeAcceptanceRequired: live.isViewingBeforeAcceptanceRequired ?? false,
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

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractTermsOfUseSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveTermsOfUse>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list agreements: ${graphErrorMessage(listed.lastError!)}` }
  }
  // Agreements reconcile by displayName and can be freely duplicated, so a
  // truncated listing would silently create a second copy — fail safe instead.
  if (listed.truncated) {
    return {
      success: false,
      message: `Cannot safely reconcile terms-of-use agreements: the listing was truncated at ~${listed.items.length} agreements, so a declared agreement could be duplicated. Reduce the number of agreements or contact support.`,
    }
  }
  const liveByName = new Map<string, LiveTermsOfUse>()
  const liveById = new Map<string, LiveTermsOfUse>()
  for (const a of listed.items) {
    if (a.displayName) liveByName.set(a.displayName.toLowerCase(), a)
    if (a.id) liveById.set(a.id, a)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      // Update: only displayName + isViewingBeforeAcceptanceRequired are patchable.
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      // Sticky provenance: keep existed:false if a prior deploy created this
      // agreement, so a later removal still deletes it (existed is otherwise
      // re-derived and would flip to true after one deploy, orphaning it).
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: priorEntry?.existed === false ? false : true,
        id: liveMatch.id,
        prior: snapshotLive(liveMatch),
      })
    } else {
      // Create requires the base64 PDF — refuse rather than emit an invalid request.
      if (!spec.fileData) {
        failures.push(`${spec.name}: PDF content (base64) is required to create a new agreement`)
        continue
      }
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveTermsOfUse>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete agreements THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some agreements failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} terms of use agreement(s)`,
    rollbackData: { entries },
  }
}
