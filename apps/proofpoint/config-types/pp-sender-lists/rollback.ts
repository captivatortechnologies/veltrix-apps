import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import { getOrg, readSenderList, senderKey, SAFE_FIELD, BLOCKED_FIELD } from './validate'
import type { SenderRollbackData } from './deploy'

/**
 * Roll back sender entries using the state captured during deploy. Deploy is
 * additive, so rollback removes exactly the entries this deploy added to the Safe
 * and Blocked lists (read-modify-write PUT of the org). Entries that already
 * existed are left untouched.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const data = ctx.rollbackData as SenderRollbackData | undefined
  const addedSafe = data?.addedSafe ?? []
  const addedBlocked = data?.addedBlocked ?? []
  if (addedSafe.length === 0 && addedBlocked.length === 0) {
    return { success: true, message: 'Nothing to roll back — this deploy added no sender entries.' }
  }

  try {
    const org = await getOrg(client)
    const removeSafe = new Set(addedSafe.map(senderKey))
    const removeBlocked = new Set(addedBlocked.map(senderKey))

    const safe = readSenderList(org, 'safe').filter((s) => !removeSafe.has(senderKey(s)))
    const blocked = readSenderList(org, 'blocked').filter((s) => !removeBlocked.has(senderKey(s)))

    const body = { ...org, [SAFE_FIELD]: safe, [BLOCKED_FIELD]: blocked }
    const res = await client.request('PUT', client.orgPath, { body })
    if (!res.ok) throw new Error(`Failed to update sender lists: ${ppErrorMessage(res)}`)

    return {
      success: true,
      message: `Rolled back ${addedSafe.length + addedBlocked.length} sender entr(ies) (${addedSafe.length} safe, ${addedBlocked.length} blocked).`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
