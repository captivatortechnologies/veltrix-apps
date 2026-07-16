import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import {
  extractSenderSpecs,
  getOrg,
  readSenderList,
  senderKey,
  SAFE_FIELD,
  BLOCKED_FIELD,
} from './validate'

export interface SenderRollbackData {
  addedSafe: string[]
  addedBlocked: string[]
}

/**
 * Deploy Proofpoint Essentials Safe/Blocked sender entries via the org object
 * (/orgs/{org}, read-modify-write PUT).
 *
 * This is ADDITIVE: read the org's current Safe and Blocked lists, add each
 * declared entry that is missing from its target list, and PUT the org back with
 * the merged lists (all other org fields preserved by read-modify-write). Entries
 * the deploy did not add are never removed. The set it added is captured so
 * rollback removes exactly those.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, orgDomain } = built

  const specs = extractSenderSpecs(ctx.canvas).filter((s) => s.sender)

  try {
    const org = await getOrg(client)
    const safe = readSenderList(org, 'safe')
    const blocked = readSenderList(org, 'blocked')
    const safeKeys = new Set(safe.map(senderKey))
    const blockedKeys = new Set(blocked.map(senderKey))

    const addedSafe: string[] = []
    const addedBlocked: string[] = []
    const deployed: string[] = []

    for (const spec of specs) {
      const key = senderKey(spec.sender)
      if (spec.listType === 'blocked') {
        if (!blockedKeys.has(key)) {
          blocked.push(spec.sender)
          blockedKeys.add(key)
          addedBlocked.push(spec.sender)
        }
      } else {
        if (!safeKeys.has(key)) {
          safe.push(spec.sender)
          safeKeys.add(key)
          addedSafe.push(spec.sender)
        }
      }
      deployed.push(`${spec.sender} (${spec.listType})`)
    }

    if (addedSafe.length > 0 || addedBlocked.length > 0) {
      const body = { ...org, [SAFE_FIELD]: safe, [BLOCKED_FIELD]: blocked }
      const res = await client.request('PUT', client.orgPath, { body })
      if (!res.ok) throw new Error(`Failed to update sender lists: ${ppErrorMessage(res)}`)
    }

    const rollbackData: SenderRollbackData = { addedSafe, addedBlocked }
    return {
      success: true,
      message:
        `Deployed ${deployed.length} sender entr(ies) to Proofpoint Essentials org "${orgDomain}" ` +
        `(added ${addedSafe.length} safe, ${addedBlocked.length} blocked): ${deployed.join(', ')}`,
      artifacts: { baseUrl, orgDomain, addedSafe, addedBlocked },
      rollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Sender-list deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl, orgDomain },
      // Nothing was persisted unless the PUT succeeded; a failed PUT leaves the
      // org unchanged, so there is nothing to roll back.
      rollbackData: { addedSafe: [], addedBlocked: [] } satisfies SenderRollbackData,
    }
  }
}
