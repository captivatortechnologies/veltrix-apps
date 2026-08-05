import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, stableStringify } from '../../lib/pingOne'
import { findPolicyByName, listActions } from './deploy'
import {
  ACTION_READONLY_FIELDS,
  actionPriority,
  extractPolicySpecs,
  parseActionsArray,
  stripReadOnly,
  type LiveAction,
} from './validate'

/**
 * Detect drift between the deployed sign-on-policy configuration and the live
 * PingOne environment. Re-finds each declared policy by name and diffs
 * `description` and `default`; re-finds each declared action by `priority`
 * and diffs the FULL action object (read-only fields stripped) against what
 * was declared. Server-managed fields (id, environment, createdAt, updatedAt,
 * _links, and the action's id/_links/environment/signOnPolicy) are never
 * modelled so they cannot read as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findPolicyByName(client, spec.name)

      if (!live || !live.id) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // description
      const liveDescription = (typeof live.description === 'string' ? live.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'critical',
        })
      }

      // default
      const liveDefault = live.default === true
      if (spec.default !== liveDefault) {
        diffs.push({
          field: `${spec.name}.default`,
          expected: spec.default,
          actual: liveDefault,
          severity: 'warning',
        })
      }

      // actions - diff each declared action (by priority) against the live
      // action at the same priority, comparing the full body.
      if (spec.actionsJson) {
        const declared = parseActionsArray(spec.actionsJson) ?? []
        const liveActions = await listActions(client, live.id)
        const byPriority = new Map<number, LiveAction>()
        for (const action of liveActions) {
          if (typeof action.priority === 'number') byPriority.set(action.priority, action)
        }

        for (const action of declared) {
          const priority = actionPriority(action)
          if (priority === null) continue
          const field = `${spec.name}.actions[priority=${priority}]`
          const match = byPriority.get(priority)

          if (!match) {
            diffs.push({ field, expected: 'present', actual: 'missing', severity: 'critical' })
            continue
          }

          const comparableLive = stripReadOnly(match as Record<string, unknown>, ACTION_READONLY_FIELDS)
          if (stableStringify(action) !== stableStringify(comparableLive)) {
            diffs.push({ field, expected: action, actual: comparableLive, severity: 'critical' })
          }
        }
      }
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
