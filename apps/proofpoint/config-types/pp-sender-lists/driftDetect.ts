import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractSenderSpecs, getSenderLists, readSenderList, scopeKey, scopeLabel, senderKey } from './validate'

/**
 * Detect drift between the deployed sender-list configuration and the live org.
 * Declared entries are grouped by scope (org/user/group) so each scope's lists
 * are fetched once; each declared entry that is no longer present in its target
 * list within its scope is critical drift (someone removed a managed sender).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSenderSpecs(ctx.deployedConfig).filter((s) => s.sender)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const byScope = new Map<string, { scope: string; scopeId: string }>()
  for (const spec of specs) byScope.set(scopeKey(spec.scope, spec.scopeId), { scope: spec.scope, scopeId: spec.scopeId })

  try {
    const listsByScope = new Map<string, { safe: Set<string>; blocked: Set<string> }>()
    for (const [key, { scope, scopeId }] of byScope) {
      const current = await getSenderLists(client, scope, scopeId)
      listsByScope.set(key, {
        safe: new Set(readSenderList(current, 'safe').map(senderKey)),
        blocked: new Set(readSenderList(current, 'blocked').map(senderKey)),
      })
    }

    for (const spec of specs) {
      const lists = listsByScope.get(scopeKey(spec.scope, spec.scopeId))
      const set = spec.listType === 'blocked' ? lists?.blocked : lists?.safe
      if (!set?.has(senderKey(spec.sender))) {
        diffs.push({
          field: `${scopeLabel(spec.scope, spec.scopeId)}:${spec.listType}:${spec.sender}`,
          expected: 'present',
          actual: 'missing',
          severity: 'critical',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'proofpoint',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
