import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage, boolFlag } from '../../lib/akeyless'
import { buildUpdateRoleBody, getRole, type RoleRollbackEntry } from './deploy'
import type { RoleSpec } from './validate'

/**
 * Roll back roles using the state captured during deploy:
 *   - base fields (description/delete_protection/access levels) are
 *     restored via /update-role when the role existed before this deploy.
 *   - rules: a rule THIS deploy created is deleted (/delete-role-rule); a
 *     rule THIS deploy changed has its prior capabilities restored
 *     (/set-role-rule). A rule this deploy left untouched is never touched.
 *   - associations: one THIS deploy added is deleted (re-fetching the role
 *     to resolve its assoc-id, since /assoc-role-am's response does not
 *     return one); one THIS deploy updated or removed is restored via
 *     /update-assoc or /assoc-role-am respectively.
 *
 * Never creates or deletes a ROLE itself on rollback - only reverts the
 * fields/rules/associations this deploy changed on a role that already
 * existed, or the rules/associations added to a brand-new role (the role
 * object itself is left in place either way, matching this app's
 * non-destructive posture for named top-level objects).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RoleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (entry.existed && entry.priorBase) {
        // Note: eventForwardersAccess is intentionally left out of the restore -
        // Akeyless overloads the "event-forwarder-rule" PathRule type for BOTH
        // the account-wide access level AND per-forwarder-name scoping (see
        // roles/canvas.yaml), so a prior account-wide value cannot be
        // unambiguously recovered from GetRole. This is a known, documented
        // limitation (see README), not an oversight.
        const restoreSpec = { name: entry.name, eventForwardersAccess: '', ...entry.priorBase } as unknown as RoleSpec
        const res = await client.request('/update-role', buildUpdateRoleBody(restoreSpec))
        if (!res.ok) throw new Error(`Failed to restore role "${entry.name}": ${akeylessErrorMessage(res)}`)
      }

      for (const rule of entry.rules) {
        if (rule.priorCapabilities === undefined) {
          const res = await client.request('/delete-role-rule', { 'role-name': entry.name, path: rule.path, 'rule-type': rule.ruleType })
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to remove rule "${rule.path}" from role "${entry.name}": ${akeylessErrorMessage(res)}`)
          }
        } else {
          const res = await client.request('/set-role-rule', {
            'role-name': entry.name,
            path: rule.path,
            'rule-type': rule.ruleType,
            capability: rule.priorCapabilities,
          })
          if (!res.ok) throw new Error(`Failed to restore rule "${rule.path}" on role "${entry.name}": ${akeylessErrorMessage(res)}`)
        }
      }

      for (const assoc of entry.associations) {
        if (!assoc.prior) {
          // This deploy ADDED it - find its current assoc-id and remove it.
          const live = await getRole(client, entry.name)
          const match = live?.role_auth_methods_assoc?.find((a) => a.auth_method_name === assoc.authMethodName)
          if (match?.assoc_id) {
            const res = await client.request('/delete-assoc', { 'assoc-id': match.assoc_id })
            if (res.status !== 404 && !res.ok) {
              throw new Error(`Failed to remove association "${assoc.authMethodName}" from role "${entry.name}": ${akeylessErrorMessage(res)}`)
            }
          }
        } else if (assoc.assocId) {
          // This deploy UPDATED it - restore the prior sub-claims/case-sensitivity.
          const res = await client.request('/update-assoc', {
            'assoc-id': assoc.assocId,
            'sub-claims': joinSubClaims(assoc.prior.subClaims),
            'case-sensitive': boolFlag(assoc.prior.caseSensitive),
          })
          if (!res.ok) throw new Error(`Failed to restore association "${assoc.authMethodName}" on role "${entry.name}": ${akeylessErrorMessage(res)}`)
        } else {
          // This deploy DELETED it - re-add it.
          const res = await client.request('/assoc-role-am', {
            'role-name': entry.name,
            'am-name': assoc.authMethodName,
            'sub-claims': joinSubClaims(assoc.prior.subClaims),
            'case-sensitive': boolFlag(assoc.prior.caseSensitive),
          })
          if (res.status !== 409 && !res.ok) {
            throw new Error(`Failed to restore association "${assoc.authMethodName}" on role "${entry.name}": ${akeylessErrorMessage(res)}`)
          }
        }
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} role(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

function joinSubClaims(subClaims: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, values] of Object.entries(subClaims)) out[key] = values.join(',')
  return out
}
