import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import {
  NOTIFICATION_RULE_ENDPOINTS,
  buildNotificationRuleBody,
  findRule,
  rulesFromResponse,
  ruleFromResponse,
  type LiveNotificationRule,
} from './_shared'

/**
 * Deploy Cortex XDR alert notification rules — a genuine full CRUD surface over
 * the newer `/platform/notifications/v1/...` REST-verb API (see
 * lib/cortexXdrApi.ts `request()`):
 *   read (identity + rollback): GET  /platform/notifications/v1/list-rules
 *   create:                     POST /platform/notifications/v1/rule
 *   update:                     PUT  /platform/notifications/v1/rule/{rule_uuid}
 *   enabled/disabled:           PATCH /platform/notifications/v1/update-rule-status/{rule_uuid}
 *
 * A rule has no caller-chosen identity — Cortex assigns `rule_uuid` on create —
 * so this reconciles by NAME: list -> match a live rule by name -> update it by
 * uuid, or create a new one. The enabled/disabled flag is NOT part of the
 * create/update body per the documented schema — it is always converged
 * separately via the status endpoint after the main body applies. rollbackData
 * records, per name, the prior live snapshot (null when it did not exist) plus
 * the created rule_uuid (when created) so rollback can restore or delete.
 *
 * VERIFY every endpoint path, the auth requirement (see cortexXdrApi.ts) and the
 * complete LogForwardType enum against a live Cortex XDR tenant.
 */
async function listRules(client: CortexXdrClient): Promise<LiveNotificationRule[]> {
  try {
    const res = await client.request('GET', NOTIFICATION_RULE_ENDPOINTS.list)
    if (!res.ok) return []
    return rulesFromResponse(res.reply)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for alert-notification-rule deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ name: string; prior: LiveNotificationRule | null; createdUuid?: string }> = []
  const applied: string[] = []

  try {
    const live = await listRules(client)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      let body
      try {
        body = buildNotificationRuleBody(item.fields)
      } catch (parseError) {
        return {
          success: false,
          message: `Alert-notification-rule deploy failed for "${name}": ${parseError instanceof Error ? parseError.message : 'invalid filter'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const match = findRule(live, name)
      const entry: (typeof previous)[number] = { name, prior: match }
      previous.push(entry)

      let ruleUuid = match?.rule_uuid
      const res = ruleUuid
        ? await client.request('PUT', NOTIFICATION_RULE_ENDPOINTS.ruleById(ruleUuid), body)
        : await client.request('POST', NOTIFICATION_RULE_ENDPOINTS.create, body)

      const error = cortexWriteError(res)
      if (error) {
        return {
          success: false,
          message: `Alert-notification-rule deploy failed for "${name}": ${error}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      if (!ruleUuid) {
        const created = ruleFromResponse(res.reply)
        ruleUuid = created?.rule_uuid
        if (ruleUuid) entry.createdUuid = ruleUuid
      }

      // enabled/disabled is a separate call — always converge it explicitly.
      if (ruleUuid) {
        const enabled = item.fields.enabled !== false && item.fields.enabled !== 'false'
        const statusRes = await client.request('PATCH', NOTIFICATION_RULE_ENDPOINTS.statusById(ruleUuid), {
          status: enabled ? 'enabled' : 'disabled',
        })
        const statusError = cortexWriteError(statusRes)
        if (statusError) {
          return {
            success: false,
            message: `Alert-notification-rule deploy applied "${name}" but failed to set its enabled state: ${statusError}`,
            artifacts: { applied },
            rollbackData: { previous },
          }
        }
      }

      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} alert notification rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Alert-notification-rule deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
