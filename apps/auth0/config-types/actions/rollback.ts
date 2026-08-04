import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, sendJson, deleteResource } from '../../lib/auth0Api'
import { deployAction, setTriggerBindings } from './network'
import type { ActionUpdateBody, BindingEntry } from './_shared'

/**
 * Undo an actions deploy from rollbackData.previous (written by deploy()),
 * processed in REVERSE deploy order (safe for multiple actions sharing a
 * trigger — each entry's bindings snapshot is only valid relative to the state
 * right before ITS deploy step ran). For each entry:
 *   1. restore the trigger's bindings to their pre-deploy snapshot (this alone
 *      unbinds an action this deploy created, before it's deleted below)
 *   2. if the action existed before, PATCH it back to its prior body — and
 *      redeploy if it had a deployed version before, so the restored code is
 *      the one that actually executes; if it did not exist before (we created
 *      it), DELETE it now that step 1 has already unbound it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{
      name: string
      actionId: string | null
      priorAction: ActionUpdateBody | null
      priorDeployed: boolean
      triggerId: string
      priorBindings: BindingEntry[]
    }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 rollback' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    for (const entry of previous.slice().reverse()) {
      const { actionId, priorAction, priorDeployed, triggerId, priorBindings } = entry
      if (!actionId) {
        skipped++
        continue
      }

      await setTriggerBindings(base, triggerId, accessToken, priorBindings)

      const path = `${base}/actions/actions/${encodeURIComponent(actionId)}`
      if (priorAction) {
        await sendJson('PATCH', path, accessToken, priorAction)
        if (priorDeployed) await deployAction(base, actionId, accessToken)
        restored++
      } else {
        await deleteResource(path, accessToken)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back actions: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
