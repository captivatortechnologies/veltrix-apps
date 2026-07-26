import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import { listTargets, type ImportTargetRollbackEntry } from './deploy'

/**
 * Roll back import targets using the state captured during deploy: a target this
 * deploy imported is deleted (which also deletes the Snyk projects created from
 * it); a target that already existed is left untouched. Because the import is
 * asynchronous, the created target's id is resolved by re-listing the org's
 * targets and matching the display name — a target that has not materialized yet
 * (or is already gone) is tolerated rather than failing the rollback.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back import targets.' }
  }

  const previousState = (ctx.rollbackData as { previousState?: ImportTargetRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const created = previousState.filter((e) => !e.existed)
  if (created.length === 0) {
    return { success: true, message: 'Nothing to roll back — all declared targets already existed' }
  }

  const deleted: string[] = []
  const notFound: string[] = []

  try {
    const live = await listTargets(client)
    const idByName = new Map(
      live
        .filter((t) => t.id && t.attributes?.display_name)
        .map((t) => [(t.attributes!.display_name as string).toLowerCase(), t.id as string]),
    )

    for (const entry of [...created].reverse()) {
      const targetId = idByName.get(entry.displayName.toLowerCase())
      if (!targetId) {
        notFound.push(entry.displayName)
        continue
      }
      const res = await client.rest('DELETE', `${client.restOrgPath()}/targets/${targetId}`)
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to delete target "${entry.displayName}": ${snykErrorMessage(res)}`)
      }
      deleted.push(entry.displayName)
    }

    const parts = [`${deleted.length} deleted`]
    if (notFound.length) parts.push(`${notFound.length} not found (import may still be processing)`)
    return { success: true, message: `Rolled back import targets: ${parts.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${deleted.length} of ${created.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
