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

export interface RollbackEntry {
  itemId?: string
  /** appId — the reconcile key and human-facing name. */
  appId: string
  /** Whether the SP existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** Prior managed fields, captured before an update so rollback can restore them. */
  prior?: Record<string, unknown>
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

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    // An SP already exists for any installed enterprise app — find it by appId.
    const found = await client.getAll<LiveServicePrincipal>(findByAppIdPath(spec.appId))
    if (!found.ok) {
      failures.push(`${spec.appId}: ${graphErrorMessage(found.lastError!)}`)
      continue
    }
    const live = found.items[0] ?? null

    if (live?.id) {
      const resp = await client.patch(`${SP_BASE}/${live.id}`, buildManagedBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.appId}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, appId: spec.appId, existed: true, id: live.id, prior: snapshotLive(live) })
    } else {
      // Rare: no SP for this app yet. Create with { appId }, then apply settings.
      const createResp = await client.post(SP_BASE, { appId: spec.appId })
      if (!createResp.ok) {
        failures.push(`${spec.appId}: ${graphErrorMessage(createResp)}`)
        continue
      }
      const created = parseJson<LiveServicePrincipal>(createResp.body)
      if (created?.id) {
        const patchResp = await client.patch(`${SP_BASE}/${created.id}`, buildManagedBody(spec))
        if (!patchResp.ok) {
          failures.push(`${spec.appId}: created but failed to apply settings: ${graphErrorMessage(patchResp)}`)
        }
      }
      entries.push({ itemId: spec.itemId, appId: spec.appId, existed: false, id: created?.id })
    }
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
