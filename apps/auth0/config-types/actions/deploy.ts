import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, sendJson } from '../../lib/auth0Api'
import { readString } from '../../lib/fields'
import {
  buildActionCreateBody,
  buildActionUpdateBody,
  findActionByName,
  snapshotAction,
  withActionBound,
  withActionUnbound,
  type ActionUpdateBody,
  type BindingEntry,
} from './_shared'
import { deployAction, getTriggerBindings, listActions, setTriggerBindings } from './network'

interface ActionSummary {
  id?: string
}

/**
 * Deploy Auth0 Actions over the Management API v2:
 *   read (identity + rollback): GET   /api/v2/actions/actions             → match by name
 *   create:                     POST  /api/v2/actions/actions              with the full body
 *   update:                     PATCH /api/v2/actions/actions/{id}         with the body (name omitted)
 *   publish:                    POST  /api/v2/actions/actions/{id}/deploy  when deploy_after_update
 *   bind/unbind:                PATCH /api/v2/actions/triggers/{id}/bindings, rebuilt from the
 *                                current list so every OTHER bound action is left untouched
 *
 * Upserts by NAME. rollbackData records, per action, the prior action body (null
 * when it did not exist), whether it had a deployed version before, the id, and
 * the FULL prior bindings list for its trigger — so rollback can restore the
 * exact pre-deploy state (see rollback.ts for why bindings must be undone before
 * a created action is deleted).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 deployment' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  const previous: Array<{
    name: string
    actionId: string | null
    priorAction: ActionUpdateBody | null
    priorDeployed: boolean
    triggerId: string
    priorBindings: BindingEntry[]
  }> = []
  const applied: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const live = await listActions(base, accessToken)

    for (const item of items) {
      const name = readString(item.fields.name)
      if (!name) continue

      const triggerId = readString(item.fields.trigger_id)
      const existing = findActionByName(live, name)

      let actionId: string | null
      let priorAction: ActionUpdateBody | null
      let priorDeployed = false

      if (existing && existing.id) {
        actionId = existing.id
        priorAction = snapshotAction(existing)
        priorDeployed = Boolean(existing.deployed_version)
        await sendJson('PATCH', `${base}/actions/actions/${encodeURIComponent(actionId)}`, accessToken, buildActionUpdateBody(item.fields))
      } else {
        const created = await sendJson<ActionSummary>('POST', `${base}/actions/actions`, accessToken, buildActionCreateBody(item.fields))
        actionId = created?.id ?? null
        priorAction = null
      }

      const deployAfterUpdate = item.fields.deploy_after_update === undefined || item.fields.deploy_after_update === true || item.fields.deploy_after_update === 'true'
      if (actionId && deployAfterUpdate) {
        await deployAction(base, actionId, accessToken)
      }

      let priorBindings: BindingEntry[] = []
      if (actionId) {
        priorBindings = await getTriggerBindings(base, triggerId, accessToken)
        const bindingEnabled = item.fields.trigger_binding_enabled === undefined || item.fields.trigger_binding_enabled === true || item.fields.trigger_binding_enabled === 'true'
        const displayName = readString(item.fields.binding_display_name) || name
        const nextBindings = bindingEnabled
          ? withActionBound(priorBindings, actionId, displayName)
          : withActionUnbound(priorBindings, actionId)
        await setTriggerBindings(base, triggerId, accessToken, nextBindings)
      }

      previous.push({ name, actionId, priorAction, priorDeployed, triggerId, priorBindings })
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} action(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 action deploy failed after ${applied.length} action(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
