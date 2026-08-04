import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { groupAttributesToBody, ruleResourceToBody } from './_shared'
import type { GroupRollbackEntry } from './deploy'

const GROUPS_PATH = '/api/v2/sensitive-data-scanner/config/groups'
const RULES_PATH = '/api/v2/sensitive-data-scanner/config/rules'

/**
 * Roll back Sensitive Data Scanner groups + rules using the state captured
 * during deploy:
 *   - a group CREATED this deploy: its rules (all created alongside it) are
 *     deleted first, then the group itself is deleted.
 *   - a group that EXISTED before this deploy: each of its rule changes is
 *     undone —
 *       - a rule CREATED this deploy is deleted
 *       - a rule UPDATED this deploy is restored (PATCH) to its prior
 *         attributes
 *       - a rule DELETED (pruned) this deploy is RE-CREATED (POST) under the
 *         same group, from its captured prior attributes (Datadog assigns it
 *         a new id — the original id cannot be restored)
 *     — then the group's own attributes are restored (PATCH).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GroupRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.groupExisted) {
        for (const ruleEntry of entry.rules) {
          if (ruleEntry.ruleId) {
            const res = await client.request('DELETE', `${RULES_PATH}/${encodeURIComponent(ruleEntry.ruleId)}`)
            if (res.status !== 404 && !res.ok) {
              throw new Error(`Failed to delete rule in group "${entry.label}": ${datadogErrorMessage(res)}`)
            }
          }
        }
        const res = await client.request('DELETE', `${GROUPS_PATH}/${encodeURIComponent(entry.groupId)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete group "${entry.label}": ${datadogErrorMessage(res)}`)
        }
      } else {
        for (const ruleEntry of entry.rules) {
          if (!ruleEntry.existed) {
            if (ruleEntry.ruleId) {
              const res = await client.request('DELETE', `${RULES_PATH}/${encodeURIComponent(ruleEntry.ruleId)}`)
              if (res.status !== 404 && !res.ok) {
                throw new Error(`Failed to delete rule in group "${entry.label}": ${datadogErrorMessage(res)}`)
              }
            }
          } else if (!ruleEntry.deleted && ruleEntry.ruleId && ruleEntry.prior) {
            const { body } = ruleResourceToBody(ruleEntry.prior)
            const res = await client.request('PATCH', `${RULES_PATH}/${encodeURIComponent(ruleEntry.ruleId)}`, {
              body: { meta: {}, data: { type: 'sensitive_data_scanner_rule', id: ruleEntry.ruleId, attributes: body } },
            })
            if (!res.ok) throw new Error(`Failed to restore rule in group "${entry.label}": ${datadogErrorMessage(res)}`)
          } else if (ruleEntry.deleted && ruleEntry.prior) {
            const { body, standardPatternId } = ruleResourceToBody(ruleEntry.prior)
            const relationships: Record<string, unknown> = { group: { data: { type: 'sensitive_data_scanner_group', id: entry.groupId } } }
            if (standardPatternId) {
              relationships.standard_pattern = { data: { type: 'sensitive_data_scanner_standard_pattern', id: standardPatternId } }
            }
            const res = await client.request('POST', RULES_PATH, {
              body: { meta: {}, data: { type: 'sensitive_data_scanner_rule', attributes: body, relationships } },
            })
            if (!res.ok) throw new Error(`Failed to recreate pruned rule in group "${entry.label}": ${datadogErrorMessage(res)}`)
          }
        }

        if (entry.priorGroup?.attributes) {
          const body = groupAttributesToBody(entry.priorGroup.attributes)
          const res = await client.request('PATCH', `${GROUPS_PATH}/${encodeURIComponent(entry.groupId)}`, {
            body: { meta: {}, data: { type: 'sensitive_data_scanner_group', id: entry.groupId, attributes: body } },
          })
          if (!res.ok) throw new Error(`Failed to restore group "${entry.label}": ${datadogErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Scanning Group(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
