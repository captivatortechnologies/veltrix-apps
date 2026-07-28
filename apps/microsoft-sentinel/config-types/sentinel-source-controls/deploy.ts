import { randomUUID } from 'node:crypto'
import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SENTINEL_API_VERSION } from '../../lib/sentinel'
import { indexByDisplayName, listSourceControls } from './healthCheck'
import {
  buildSourceControlBody,
  extractSourceControlSpecs,
  pickNonSecretProperties,
  sourceControlKey,
  type SourceControlProperties,
} from './validate'

/**
 * State captured per source control so a rollback can delete creates and restore
 * updates. `prior` carries ONLY non-secret properties — the write-only
 * repositoryAccess credential is never read back (ARM never returns it) or stored.
 */
export interface SourceControlRollbackEntry {
  displayName: string
  /** The server GUID this deploy wrote to (matched existing, or freshly generated). */
  sourceControlId: string
  existed: boolean
  prior?: SourceControlProperties
}

/**
 * Deploy source controls (repository connections) via ARM. The server id is a
 * GUID, so reconciliation is by DISPLAY NAME: list sourcecontrols, match
 * client-side, PUT the matched GUID (update) or a freshly generated GUID (create).
 *
 * ⚠ SECRET: the repositoryAccess credential (PAT token / OAuth code / App
 * installation id) is sent on create AND update but is WRITE-ONLY — it is never
 * returned on GET, never placed in rollbackData / artifacts, and never logged.
 *
 * ⚠ SIDE EFFECT: creating a source control provisions a webhook in a GitHub repo,
 * or a pipeline + service connection in an Azure DevOps project. Deploying and
 * rolling back are therefore NOT side-effect-free in the external repository.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractSourceControlSpecs(ctx.canvas).filter((s) => s.displayName && s.repoUrl && s.repoBranch)
  const rollbackState: SourceControlRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    // One list serves every lookup — the collection is reconciled by display name.
    const live = await listSourceControls(client)
    const byName = indexByDisplayName(live)

    for (const spec of specs) {
      const existing = byName.get(sourceControlKey(spec.displayName))
      const existed = Boolean(existing?.name)
      const sourceControlId = existing?.name ?? randomUUID()

      rollbackState.push({
        displayName: spec.displayName,
        sourceControlId,
        existed,
        prior: existed ? pickNonSecretProperties(existing?.properties) : undefined,
      })

      const res = await client.request('PUT', client.sentinelPath(`/sourcecontrols/${sourceControlId}`), {
        apiVersion: SENTINEL_API_VERSION,
        body: buildSourceControlBody(spec),
      })
      if (!res.ok) {
        throw new Error(`Failed to ${existed ? 'update' : 'create'} source control "${spec.displayName}": ${armErrorMessage(res)}`)
      }
      ;(existed ? updated : created).push(spec.displayName)
    }

    return {
      success: true,
      message: `Source controls deployed to ${armHost}: ${created.length} created, ${updated.length} updated`,
      // artifacts carry names only — never the repository credential.
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Source control deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, created, updated },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}
