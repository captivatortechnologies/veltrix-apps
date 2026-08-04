import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { buildExtensionAttributeBody, type LiveExtensionAttribute } from './validate'
import type { ExtensionAttributeRollbackEntry } from './deploy'

const EXTENSION_ATTRIBUTES_PATH = '/v1/computer-extension-attributes'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ExtensionAttributeRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${EXTENSION_ATTRIBUTES_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete extension attribute "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `${EXTENSION_ATTRIBUTES_PATH}/${encodeURIComponent(entry.id)}`, priorToBody(entry.prior))
        if (res.error) throw new Error(`Failed to restore extension attribute "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} Jamf Pro extension attribute(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

function priorToBody(prior: LiveExtensionAttribute): Record<string, unknown> {
  const body: Record<string, unknown> = { ...prior }
  delete body.id
  return body
}
