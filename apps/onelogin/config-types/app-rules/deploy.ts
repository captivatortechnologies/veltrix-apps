import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, parseJson, oneLoginErrorMessage, reconcileOrder, type OneLoginClient } from '../../lib/oneLogin'
import { extractAppRuleSpecs, type AppRuleSpec, type LiveAppRule } from './validate'

/** The full writable surface of an app rule - everything create/update accepts. */
export interface AppRuleWriteInput {
  name: string
  match: 'all' | 'any'
  enabled: boolean
  conditions: unknown[]
  actions: unknown[]
}

export interface AppRuleRollbackEntry {
  appId: number
  name: string
  existed: boolean
  id?: number
  prior?: AppRuleWriteInput
}

/**
 * Deploy OneLogin app rules via the App Rules API, grouped by target app.
 *
 * ONE item = ONE rule, matched on the (appId, name) PAIR within that app's
 * own rule list (OneLogin has no upsert):
 *   - list GET  /api/2/apps/{appId}/rules          (client.getAll, Link-header paginated)
 *   - PUT       /api/2/apps/{appId}/rules/{id}     - replace an existing rule's writable fields
 *   - POST      /api/2/apps/{appId}/rules          - create a missing one (capture the new id)
 *
 * Then reconciles ORDER PER APP: OneLogin's Bulk Sort
 * (PUT /api/2/apps/{appId}/rules/sort) requires the COMPLETE rule-id list for
 * THAT APP (a partial list 422s), so this app captures each app's full live
 * rule order BEFORE making any change, then uses {@link reconcileOrder} to
 * non-destructively re-insert that app's managed rules (in the exact order
 * declared) at the position of the first one that already existed - see
 * canvas.yaml for the full reasoning.
 *
 * Never deletes a rule absent from this canvas - rollback only reverts what
 * THIS deploy created, changed, or reordered.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractAppRuleSpecs(ctx.canvas).filter(
    (s) => s.appId !== undefined && s.name && s.conditionsJson && s.actionsJson,
  )
  const rollbackState: AppRuleRollbackEntry[] = []
  const createdIds: Array<{ appId: number; id: number }> = []
  const originalOrders: Record<number, number[]> = {}
  const deployed: string[] = []

  const byApp = new Map<number, AppRuleSpec[]>()
  for (const spec of specs) {
    const appId = spec.appId as number
    if (!byApp.has(appId)) byApp.set(appId, [])
    byApp.get(appId)!.push(spec)
  }

  try {
    for (const [appId, appSpecs] of byApp) {
      const liveRules = await listAppRules(client, appId)
      const originalFullOrder = liveRules.map((r) => r.id).filter((id): id is number => typeof id === 'number')
      originalOrders[appId] = originalFullOrder

      const managedIds: number[] = []

      for (const spec of appSpecs) {
        const input = specToWriteInput(spec)
        const existing = liveRules.find((r) => r.name === spec.name) ?? null

        if (existing?.id) {
          rollbackState.push({ appId, name: spec.name, existed: true, id: existing.id, prior: liveRuleToWriteInput(existing) })
          managedIds.push(existing.id)

          const res = await client.request('PUT', `/api/2/apps/${appId}/rules/${existing.id}`, { body: buildAppRuleBody(input) })
          if (!res.ok) {
            throw new Error(`Failed to update app rule "${spec.name}" for app ${appId}: ${oneLoginErrorMessage(res)}`)
          }
        } else {
          const res = await client.request('POST', `/api/2/apps/${appId}/rules`, { body: buildAppRuleBody(input) })
          if (!res.ok) {
            throw new Error(`Failed to create app rule "${spec.name}" for app ${appId}: ${oneLoginErrorMessage(res)}`)
          }
          const created = parseJson<LiveAppRule>(res.body)
          if (!created?.id) {
            throw new Error(`App rule "${spec.name}" for app ${appId} was created but the API returned no id`)
          }
          createdIds.push({ appId, id: created.id })
          managedIds.push(created.id)
          rollbackState.push({ appId, name: spec.name, existed: false, id: created.id })
        }

        deployed.push(`${spec.name} (app ${appId})`)
      }

      if (managedIds.length > 0) {
        const newOrder = reconcileOrder(originalFullOrder.map(String), managedIds.map(String)).map(Number)
        await sortAppRules(client, appId, newOrder)
      }
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} app rule(s) to OneLogin account ${domain}: ${deployed.join(', ')}`,
      artifacts: { domain, deployedAppRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds, originalOrders },
    }
  } catch (error) {
    return {
      success: false,
      message: `App rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedAppRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every rule for one app, sorted by position ascending. */
export async function listAppRules(client: OneLoginClient, appId: number): Promise<LiveAppRule[]> {
  const res = await client.getAll<LiveAppRule>(`/api/2/apps/${appId}/rules`)
  if (!res.ok) {
    throw new Error(
      `Failed to list app rules for app ${appId}: ${oneLoginErrorMessage({ status: res.status, ok: res.ok, body: res.body, linkHeader: null })}`,
    )
  }
  return [...res.items].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
}

/** PUT /api/2/apps/{appId}/rules/sort - the COMPLETE ordered rule-id list for that app. */
export async function sortAppRules(client: OneLoginClient, appId: number, orderedIds: number[]): Promise<void> {
  const res = await client.request('PUT', `/api/2/apps/${appId}/rules/sort`, { body: orderedIds })
  if (!res.ok) {
    throw new Error(`Failed to reorder app rules for app ${appId}: ${oneLoginErrorMessage(res)}`)
  }
}

function specToWriteInput(spec: AppRuleSpec): AppRuleWriteInput {
  return {
    name: spec.name,
    match: spec.match,
    enabled: spec.enabled,
    conditions: JSON.parse(spec.conditionsJson),
    actions: JSON.parse(spec.actionsJson),
  }
}

/** Capture a live rule's writable fields - used both for rollback and as the base of a prior-state PUT. */
export function liveRuleToWriteInput(existing: LiveAppRule): AppRuleWriteInput {
  return {
    name: existing.name ?? '',
    match: existing.match === 'any' ? 'any' : 'all',
    enabled: existing.enabled ?? true,
    conditions: existing.conditions ?? [],
    actions: existing.actions ?? [],
  }
}

/** Build the create/update request body from a writable-fields input. */
export function buildAppRuleBody(input: AppRuleWriteInput): Record<string, unknown> {
  return {
    name: input.name,
    match: input.match,
    enabled: input.enabled,
    conditions: input.conditions,
    actions: input.actions,
  }
}
