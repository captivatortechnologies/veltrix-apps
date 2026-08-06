import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient } from '../../lib/kandjiApi'
import { buildCustomProfileForm, type CustomProfileSpec, type LiveCustomProfile } from './validate'
import type { CustomProfileRollbackEntry } from './deploy'

const CUSTOM_PROFILES_PATH = '/api/v1/library/custom-profiles'

/**
 * Roll back Custom Profiles using the state captured during deploy:
 *   - profiles this deploy CREATED are deleted
 *   - profiles this deploy UPDATED are restored to their prior content —
 *     Kandji's GET returns the full plist back (`profile`), so the exact
 *     prior payload can be re-uploaded, unlike Custom Apps/In-House Apps
 *     which only ever hand back a `file_url`.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: CustomProfileRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${CUSTOM_PROFILES_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete Custom Profile "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.requestMultipart(
          'PATCH',
          `${CUSTOM_PROFILES_PATH}/${encodeURIComponent(entry.id)}`,
          priorToForm(entry.prior),
        )
        if (res.error) throw new Error(`Failed to restore Custom Profile "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} Kandji Custom Profile(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

function priorToForm(prior: LiveCustomProfile): FormData {
  const spec: CustomProfileSpec = {
    sectionName: '',
    name: prior.name ?? '',
    active: prior.active ?? true,
    runsOnMac: prior.runs_on_mac ?? true,
    runsOnIphone: prior.runs_on_iphone ?? false,
    runsOnIpad: prior.runs_on_ipad ?? false,
    runsOnTv: prior.runs_on_tv ?? false,
    profile: prior.profile ?? '',
  }
  return buildCustomProfileForm(spec)
}
