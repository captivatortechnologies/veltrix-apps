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
  effectiveSsoMode,
  extractServicePrincipalSpecs,
  findByAppIdPath,
  SP_BASE,
  type LiveServicePrincipal,
  type ServicePrincipalSpec,
} from './validate'
import { buildOwnerPrincipalNameMaps, resolveOwnerPrincipals } from '../lib/principals'
import { reconcileRefCollection, type RefMemberEntry } from '../lib/refReconcile'

export interface RollbackEntry {
  itemId?: string
  /** appId — the reconcile key and human-facing name. */
  appId: string
  /** Whether the SP existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** Prior managed fields, captured before an update so rollback can restore them. */
  prior?: Record<string, unknown>
  /** Tracked owners, with provenance — see RefMemberEntry. */
  owners?: RefMemberEntry[]
}

/** The mutable managed fields — the body of a PATCH (and of the post-create PATCH). */
export function buildManagedBody(spec: ServicePrincipalSpec): Record<string, unknown> {
  return {
    accountEnabled: spec.accountEnabled,
    appRoleAssignmentRequired: spec.appRoleAssignmentRequired,
    preferredSingleSignOnMode: effectiveSsoMode(spec) || null,
    homepage: spec.homepage || null,
    notificationEmailAddresses: spec.notificationEmailAddresses,
    tags: spec.tags,
  }
}

/** Snapshot the live managed fields so an update can be reversed on rollback. */
function snapshotLive(live: LiveServicePrincipal): Record<string, unknown> {
  return {
    accountEnabled: live.accountEnabled ?? true,
    appRoleAssignmentRequired: live.appRoleAssignmentRequired ?? false,
    preferredSingleSignOnMode: live.preferredSingleSignOnMode ?? null,
    homepage: live.homepage ?? null,
    notificationEmailAddresses: live.notificationEmailAddresses ?? [],
    tags: live.tags ?? [],
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

  const specs = extractServicePrincipalSpecs(ctx.canvas).filter((s) => s.appId)
  const prior = await loadPriorEntries(ctx)
  const priorByAppId = new Map(prior.map((e) => [e.appId.toLowerCase(), e]))

  // Owner references resolve against users/service principals — a
  // picker-selected value passes straight through; a hand-typed display
  // name/UPN falls back to these live maps, built once for the whole deploy.
  const ownerMaps = await buildOwnerPrincipalNameMaps(client)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = priorByAppId.get(spec.appId.toLowerCase())

    // An SP already exists for any installed enterprise app — find it by appId.
    const found = await client.getAll<LiveServicePrincipal>(findByAppIdPath(spec.appId))
    if (!found.ok) {
      failures.push(`${spec.appId}: ${graphErrorMessage(found.lastError!)}`)
      continue
    }
    const live = found.items[0] ?? null
    let spId: string | undefined
    let entry: RollbackEntry

    if (live?.id) {
      const resp = await client.patch(`${SP_BASE}/${live.id}`, buildManagedBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.appId}: ${graphErrorMessage(resp)}`)
        continue
      }
      spId = live.id
      // Sticky provenance: keep existed:false if a prior deploy created this SP,
      // so a later removal still deletes it (existed is otherwise re-derived and
      // would flip to true after one deploy, orphaning the SP).
      entry = {
        itemId: spec.itemId,
        appId: spec.appId,
        existed: priorEntry?.existed === false ? false : true,
        id: live.id,
        prior: snapshotLive(live),
      }
    } else {
      // Rare: no SP for this app yet. Create with { appId }, then apply settings.
      const createResp = await client.post(SP_BASE, { appId: spec.appId })
      if (!createResp.ok) {
        failures.push(`${spec.appId}: ${graphErrorMessage(createResp)}`)
        continue
      }
      const created = parseJson<LiveServicePrincipal>(createResp.body)
      spId = created?.id
      if (created?.id) {
        const patchResp = await client.patch(`${SP_BASE}/${created.id}`, buildManagedBody(spec))
        if (!patchResp.ok) {
          failures.push(`${spec.appId}: created but failed to apply settings: ${graphErrorMessage(patchResp)}`)
        }
      }
      entry = { itemId: spec.itemId, appId: spec.appId, existed: false, id: created?.id }
    }

    if (spId) {
      const ownerResolution = resolveOwnerPrincipals(spec.owners, ownerMaps)
      if (ownerResolution.missing.length) {
        failures.push(
          `${spec.appId}: unknown owner(s) ${ownerResolution.missing.join(', ')} — create/verify them first or fix the name`
        )
        entry.owners = priorEntry?.owners ?? []
      } else {
        const { members, failures: ownerFailures } = await reconcileRefCollection(
          client,
          `${SP_BASE}/${spId}`,
          'owners',
          ownerResolution.ids,
          priorEntry?.owners ?? []
        )
        entry.owners = members
        for (const f of ownerFailures) failures.push(`${spec.appId}: ${f}`)
      }
    }

    entries.push(entry)
  }

  // Reconcile: delete SPs THIS app created previously but no longer declares.
  // Never touches a pre-existing SP (existed:true is only ever restored, not deleted).
  const declared = new Set(specs.map((s) => s.appId.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declared.has(p.appId.toLowerCase())) {
      const resp = await client.delete(`${SP_BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.appId}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some service principals failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} service principal(s)`,
    rollbackData: { entries },
  }
}
