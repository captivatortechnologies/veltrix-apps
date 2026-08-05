import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  deleteEntity,
  postForm,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
} from '../../lib/splunkRest'
import { readAcsSettings, resolveAcsToken, resolveStackName, type AcsRequestOptions } from '../../lib/acs'
import { describeTarget, withTarget } from '../../lib/acsIdentity'
import { ROLES_BASE_PATH, buildRestorePayload, normalizeRoleRollbackEntry, type RoleRollbackEntry } from './deploy'
import { buildAcsRoleRestorePayload, deleteAcsRole, updateAcsRole } from './acsRoles'

/**
 * Roll back role configuration using the state captured during deploy, per
 * transport (see deploy.ts):
 *
 *   REST: a role the deploy created is DELETEd; a role it updated is POSTed
 *         back to its captured prior values.
 *   ACS:  the same, per declared search-head target — a role the deploy
 *         created on a target is DELETEd from that target; one it updated
 *         there is PATCHed back to its captured prior values there.
 *
 * Entries are normalized through normalizeRoleRollbackEntry() first, so a
 * rollback of a deployment made by the PRE-v1.12.0 code (flat, REST-only
 * rollbackData) works identically to one made by the current code — no data
 * migration needed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const rawState = (ctx.rollbackData as { previousState?: unknown[] })?.previousState
  if (!rawState || rawState.length === 0) {
    return { success: false, message: 'No previous state available for role rollback' }
  }

  const entries = rawState.map(normalizeRoleRollbackEntry).filter((e): e is RoleRollbackEntry => e !== null)
  if (entries.length === 0) {
    return { success: false, message: 'Previous state for role rollback was in an unrecognized shape' }
  }

  const needsRest = entries.some((e) => e.transport === 'rest')
  const needsAcs = entries.some((e) => e.transport === 'acs')

  const restToken = resolveRestToken(ctx.credential)
  if (needsRest && !restToken) {
    return { success: false, message: `Rollback cannot reach the stack. ${REST_TOKEN_MISSING}` }
  }

  const acsToken = resolveAcsToken(ctx.credential)
  if (needsAcs && !acsToken) {
    return {
      success: false,
      message:
        'Rollback cannot reach ACS. No ACS token available — store the Splunk Cloud JWT (sc_admin) in the credential "API token" field',
    }
  }

  const { timeoutMs: restTimeoutMs } = readRestSettings(ctx.settings)
  const stackHost = resolveStackHost(ctx.component.hostname)
  const restBaseUrl = buildRestUrl(ctx.component)
  const restAuth = restToken ? buildAuthHeader(restToken) : {}

  const acsSettings = readAcsSettings(ctx.settings)
  const baseStack = resolveStackName(ctx.component.hostname)
  const acsBase: AcsRequestOptions = {
    baseUrl: acsSettings.baseUrl,
    stack: baseStack,
    token: acsToken ?? '',
    timeoutMs: acsSettings.timeoutMs,
  }

  const reverted: string[] = []
  const deleted: string[] = []

  try {
    for (const entry of entries) {
      if (entry.transport === 'acs') {
        await rollbackAcsRole(acsBase, baseStack, entry, deleted)
      } else {
        await rollbackRestRole(restBaseUrl, restAuth, restTimeoutMs, entry, deleted)
      }
      reverted.push(entry.name)
    }

    const actions: string[] = []
    const restored = reverted.length - deleted.length
    if (restored > 0) actions.push(`restored ${restored} role(s)`)
    if (deleted.length > 0) actions.push(`reverted ${deleted.length} created role instance(s)`)

    return {
      success: true,
      message: `Rolled back ${reverted.length} role(s) on stack "${stackHost}": ${actions.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Role rollback failed after ${reverted.length} of ${entries.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

async function rollbackRestRole(
  baseUrl: string,
  auth: Record<string, string>,
  timeoutMs: number,
  entry: RoleRollbackEntry,
  deleted: string[],
): Promise<void> {
  const rolePath = `${ROLES_BASE_PATH}/${encodeURIComponent(entry.name)}`
  const target = entry.targets[0]
  if (!target) return

  if (!target.existed) {
    await deleteEntity(baseUrl, auth, rolePath, timeoutMs)
    deleted.push(entry.name)
    return
  }

  const payload = buildRestorePayload(target.prior ?? {})
  if (Object.keys(payload).length > 0) {
    await postForm(baseUrl, auth, rolePath, payload, timeoutMs)
  }
}

async function rollbackAcsRole(
  acsBase: AcsRequestOptions,
  baseStack: string,
  entry: RoleRollbackEntry,
  deleted: string[],
): Promise<void> {
  for (const target of entry.targets) {
    const acs = withTarget(acsBase, baseStack, target.target)
    try {
      if (!target.existed) {
        await deleteAcsRole(acs, entry.name)
        deleted.push(`${entry.name}@${describeTarget(target.target)}`)
      } else {
        await updateAcsRole(acs, entry.name, buildAcsRoleRestorePayload(target.prior ?? {}))
      }
    } catch (error) {
      throw new Error(
        `role "${entry.name}" on ${describeTarget(target.target)} (ACS): ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      )
    }
  }
}
