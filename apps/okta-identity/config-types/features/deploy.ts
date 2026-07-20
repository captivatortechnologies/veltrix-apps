import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, type OktaClient } from '../../lib/okta'
import { extractFeatureSpecs, type LiveFeature } from './validate'

export interface FeatureRollbackEntry {
  /** Feature name — for messages only; rollback keys on the id. */
  name: string
  /** The feature id Okta assigns — the rollback key (never the name). */
  id: string
  /** Prior lifecycle status (ENABLED|DISABLED), replayed via lifecycle on rollback. */
  priorStatus: string
}

export interface FeatureRollbackData {
  previousState: FeatureRollbackEntry[]
  /** Always empty — a feature can never be created, so there is nothing to delete. */
  createdIds: string[]
}

/**
 * Deploy self-service feature toggles to an Okta org. Features are UPDATE-ONLY —
 * there is no create and no delete — so for each declared feature:
 *   - GET  /features                          — list (paginated) and match by name
 *   - POST /features/{id}/{ENABLE|DISABLE}    — reconcile to the desired status
 *                                               (?mode=force overrides dependency
 *                                               / dependent restrictions)
 *
 * A feature whose name does not match any existing self-service feature in the org
 * is a hard error: it cannot be created through the API.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractFeatureSpecs(ctx.canvas).filter((s) => s.name)
  const previousState: FeatureRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const live = await findFeature(client, spec.name)
      if (!live || !live.id) {
        throw new Error(
          `Feature "${spec.name}" was not found in this Okta org — features cannot be created through the API. The name must match an existing self-service feature (check the spelling and that the feature is available in this org).`,
        )
      }

      // Capture the prior status for rollback (keyed on the returned id, never the name).
      const priorStatus = (live.status ?? '').toUpperCase()
      previousState.push({ name: spec.name, id: live.id, priorStatus })

      // Converge to the desired lifecycle status. reconcileFeatureStatus no-ops when
      // the feature is already at the desired status (still recorded as deployed).
      await reconcileFeatureStatus(client, live.id, priorStatus, spec.status, spec.forceDependencies)

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Reconciled ${deployed.length} feature toggle(s) on Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedFeatures: deployed },
      rollbackData: { previousState, createdIds: [] },
    }
  } catch (error) {
    return {
      success: false,
      message: `Feature toggle deployment failed after ${deployed.length} of ${specs.length} feature(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedFeatures: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState, createdIds: [] },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Find a self-service feature by name (case-insensitive) across the paginated list; null when absent. */
export async function findFeature(client: OktaClient, name: string): Promise<LiveFeature | null> {
  const res = await client.getAll<LiveFeature>('/features')
  if (!res.ok) {
    throw new Error(
      `Failed to list features while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  const target = name.trim().toLowerCase()
  return res.items.find((f) => (f.name ?? '').trim().toLowerCase() === target) ?? null
}

/**
 * Converge a feature's lifecycle status. Okta toggles a feature through its
 * lifecycle endpoint (POST /features/{id}/ENABLE|DISABLE), not a PUT body. No-op
 * when the desired status already matches the current one. `force` sends
 * `?mode=force` so Okta also enables required dependencies (on ENABLE) or disables
 * dependents (on DISABLE) instead of failing on the restriction.
 */
export async function reconcileFeatureStatus(
  client: OktaClient,
  featureId: string,
  currentStatus: string | undefined,
  desiredStatus: string,
  force: boolean,
): Promise<void> {
  const desired = desiredStatus.toUpperCase()
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desired) return

  const lifecycle = desired === 'ENABLED' ? 'ENABLE' : 'DISABLE'
  const res = await client.request('POST', `/features/${featureId}/${lifecycle}`, {
    query: { mode: force ? 'force' : undefined },
  })
  if (!res.ok) {
    throw new Error(`Failed to ${lifecycle.toLowerCase()} feature ${featureId}: ${oktaErrorMessage(res)}`)
  }
}
