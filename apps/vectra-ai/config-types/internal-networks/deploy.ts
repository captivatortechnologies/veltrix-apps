import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson, sendJson } from '../../lib/vectraApi'
import { buildDesiredState, stateFromGet } from './_shared'

/**
 * Deploy the Vectra Internal Networks singleton over the Detect REST API (v2.5, 443):
 *   read (rollback): GET  /settings/internal_network
 *   write:            POST /settings/internal_network  body { include, exclude, drop }
 *
 * A FULL REPLACE — the declared item is the complete desired state for the whole
 * brain. rollbackData records the prior state (the GET response remapped to the
 * write body's key names) so rollback can restore it exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]

  if (!credential) {
    return { success: false, message: 'Missing credential for internal networks deployment' }
  }
  if (!item) {
    return { success: false, message: 'No internal networks configuration declared' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  try {
    const previous = stateFromGet(await getJson<unknown>(`${base}/settings/internal_network`, headers))
    const desired = buildDesiredState(item.fields)

    await sendJson('POST', `${base}/settings/internal_network`, headers, desired)

    return {
      success: true,
      message: `Applied internal networks: ${desired.include.length} included, ${desired.exclude.length} excluded, ${desired.drop.length} dropped.`,
      artifacts: { desired },
      rollbackData: { previous },
    }
  } catch (error) {
    return { success: false, message: `Internal networks deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
