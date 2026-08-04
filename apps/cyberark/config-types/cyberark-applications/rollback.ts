import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage } from '../../lib/cyberark'
import { listAuthMethods, reconcileAuthMethods } from './deploy'
import type { ApplicationRollbackEntry } from './deploy'
import type { AuthMethodSpec, LiveAuthMethod } from './validate'

/**
 * Roll back applications using the state captured during deploy:
 *   - an application THIS DEPLOY created is deleted outright (its
 *     authentication methods are removed along with it).
 *   - an application that already existed is left in place (there is no
 *     verified delete-or-restore for its top-level fields — see deploy.ts);
 *     only its authentication methods are restored to their prior list, by
 *     reconciling against the SAME captured snapshot in reverse.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ApplicationRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        const res = await client.requestLegacy('DELETE', `/Applications/${encodeURIComponent(entry.label)}/`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete application "${entry.label}": ${cyberArkErrorMessage(res)}`)
        }
      } else {
        const currentLive = await listAuthMethods(client, entry.label)
        const desired = toAuthMethodSpecs(entry.priorAuthMethods)
        await reconcileAuthMethods(client, entry.label, desired, currentLive)
      }
      reverted.push(entry.label)
    }

    await client.logoff()
    return { success: true, message: `Rolled back ${reverted.length} application(s): ${reverted.join(', ')}` }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Map the captured live snapshot back to the AuthMethodSpec shape reconcileAuthMethods() expects. */
function toAuthMethodSpecs(live: LiveAuthMethod[]): AuthMethodSpec[] {
  return live
    .filter((m): m is LiveAuthMethod & { AuthType: string } => typeof m.AuthType === 'string' && !!m.AuthType)
    .map((m) => ({
      authType: m.AuthType,
      authValue: m.AuthValue,
      isFolder: typeof m.IsFolder === 'boolean' ? m.IsFolder : m.IsFolder === 'true',
      allowInternalScripts: typeof m.AllowInternalScripts === 'boolean' ? m.AllowInternalScripts : m.AllowInternalScripts === 'true',
      comment: m.Comment,
      issuer: m.Issuer,
      subject: m.Subject,
      subjectAlternativeName: m.SubjectAlternativeName,
    }))
}
