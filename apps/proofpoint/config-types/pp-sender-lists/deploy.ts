import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import {
  extractSenderSpecs,
  getSenderLists,
  readSenderList,
  scopeKey,
  scopeLabel,
  senderKey,
  senderListsPath,
  SAFE_FIELD,
  BLOCKED_FIELD,
  type SenderSpec,
} from './validate'

export interface ScopeRollbackEntry {
  scope: string
  scopeId: string
  changedAllow: boolean
  priorAllowList: string[]
  changedBlock: boolean
  priorBlockList: string[]
}

export interface SenderRollbackData {
  scopes: ScopeRollbackEntry[]
}

/** Group specs by their (scope, scopeId) tuple, preserving first-seen order. */
function groupByScope(specs: SenderSpec[]): Map<string, { scope: string; scopeId: string; entries: SenderSpec[] }> {
  const groups = new Map<string, { scope: string; scopeId: string; entries: SenderSpec[] }>()
  for (const spec of specs) {
    const key = scopeKey(spec.scope, spec.scopeId)
    const group = groups.get(key)
    if (group) {
      group.entries.push(spec)
    } else {
      groups.set(key, { scope: spec.scope, scopeId: spec.scopeId, entries: [spec] })
    }
  }
  return groups
}

/**
 * Deploy Proofpoint Essentials Safe/Blocked sender entries via the dedicated
 * sender-lists resource, scoped to the organization, a user or a group:
 *   GET   /orgs/{org}[/users/{email}|/groups/{id}]/sender-lists
 *   PATCH /orgs/{org}[/users/{email}|/groups/{id}]/sender-lists
 *
 * This is ADDITIVE per scope: for each declared scope, read its current Safe and
 * Blocked lists, compute the full desired array (current entries plus any
 * declared entries missing from it), and PATCH back only the list(s) that
 * changed — entries not declared here are never removed. The exact prior array
 * of each list PATCHed is captured so rollback can restore it verbatim.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, orgDomain } = built

  const specs = extractSenderSpecs(ctx.canvas).filter((s) => s.sender)
  const groups = groupByScope(specs)

  const rollbackScopes: ScopeRollbackEntry[] = []
  const deployed: string[] = []
  let addedSafe = 0
  let addedBlocked = 0
  let processedScopes = 0

  try {
    for (const { scope, scopeId, entries } of groups.values()) {
      const current = await getSenderLists(client, scope, scopeId)
      const safe = readSenderList(current, 'safe')
      const blocked = readSenderList(current, 'blocked')
      const safeKeys = new Set(safe.map(senderKey))
      const blockedKeys = new Set(blocked.map(senderKey))

      const desiredSafe = [...safe]
      const desiredBlocked = [...blocked]
      let changedAllow = false
      let changedBlock = false

      for (const spec of entries) {
        const key = senderKey(spec.sender)
        if (spec.listType === 'blocked') {
          if (!blockedKeys.has(key)) {
            desiredBlocked.push(spec.sender)
            blockedKeys.add(key)
            changedBlock = true
            addedBlocked++
          }
        } else if (!safeKeys.has(key)) {
          desiredSafe.push(spec.sender)
          safeKeys.add(key)
          changedAllow = true
          addedSafe++
        }
        deployed.push(`${spec.sender} (${spec.listType}) [${scopeLabel(scope, scopeId)}]`)
      }

      if (changedAllow || changedBlock) {
        const body: Record<string, unknown> = {}
        if (changedAllow) body[SAFE_FIELD] = desiredSafe
        if (changedBlock) body[BLOCKED_FIELD] = desiredBlocked

        const res = await client.request('PATCH', senderListsPath(client, scope, scopeId), { body })
        if (!res.ok) throw new Error(`Failed to update sender lists for ${scopeLabel(scope, scopeId)}: ${ppErrorMessage(res)}`)

        rollbackScopes.push({ scope, scopeId, changedAllow, priorAllowList: safe, changedBlock, priorBlockList: blocked })
      }
      processedScopes++
    }

    return {
      success: true,
      message:
        `Deployed ${deployed.length} sender entr(ies) across ${processedScopes} scope(s) to Proofpoint Essentials org ` +
        `"${orgDomain}" (added ${addedSafe} safe, ${addedBlocked} blocked): ${deployed.join(', ')}`,
      artifacts: { baseUrl, orgDomain, addedSafe, addedBlocked, scopesTouched: rollbackScopes.length },
      rollbackData: { scopes: rollbackScopes } satisfies SenderRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Sender-list deployment failed after ${processedScopes} of ${groups.size} scope(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, orgDomain },
      rollbackData: { scopes: rollbackScopes } satisfies SenderRollbackData,
    }
  }
}
