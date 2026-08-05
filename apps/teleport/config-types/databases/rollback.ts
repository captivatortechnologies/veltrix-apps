import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, teleportErrorMessage } from '../../lib/teleport'
import type { DatabaseRollbackEntry } from './deploy'

/**
 * Roll back database resources using the state captured during deploy.
 *
 * IMPORTANT — verified gap: the Teleport Proxy web API has no DELETE route
 * for a dynamic database resource (lib/web/apiserver.go's
 * `bindDefaultEndpoints` registers GET/POST .../databases and GET/PUT
 * .../databases/{name}, but no DELETE — gravitational/teleport@master).
 * So a database this deploy CREATED cannot be removed by this handler; it is
 * reported as requiring manual removal (`tctl rm db/<name>`, or via the
 * gRPC Auth API) rather than silently left in place unexplained.
 *
 * A database this deploy UPDATED restores its prior protocol/uri/labels via
 * the same overwrite POST used by deploy.ts. AWS RDS metadata and the CA
 * certificate cannot be read back from Teleport (see deploy.ts's
 * `DatabaseRollbackEntry` comment) and so are not restored.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DatabaseRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const restored: string[] = []
  const requiresManualRemoval: string[] = []

  try {
    const site = await client.resolveSite()

    for (const entry of previousState) {
      if (!entry.existed) {
        // No DELETE route exists for this resource via the web API — see the module comment.
        requiresManualRemoval.push(entry.name)
        continue
      }

      const res = await client.request('POST', `/v1/webapi/sites/${encodeURIComponent(site)}/databases`, {
        body: {
          name: entry.name,
          protocol: entry.priorProtocol,
          uri: entry.priorUri,
          labels: entry.priorLabels ?? [],
          overwrite: true,
        },
      })
      if (!res.ok) {
        throw new Error(`Failed to restore database "${entry.name}": ${teleportErrorMessage(res)}`)
      }
      restored.push(entry.name)
    }

    const parts: string[] = []
    if (restored.length > 0) parts.push(`Restored ${restored.length} database(s): ${restored.join(', ')}.`)
    if (requiresManualRemoval.length > 0) {
      parts.push(
        `${requiresManualRemoval.length} database(s) were created by this deploy and could not be removed — the ` +
          `Teleport web API has no delete route for this resource. Remove manually with \`tctl rm db/<name>\`: ${requiresManualRemoval.join(', ')}.`,
      )
    }
    if (parts.length === 0) parts.push('Nothing to roll back.')

    return { success: true, message: parts.join(' ') }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after restoring ${restored.length} of ${previousState.length} database(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
