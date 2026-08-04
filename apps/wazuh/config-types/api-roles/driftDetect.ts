import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, listAffectedItems } from '../../lib/wazuhApi'
import { specFromItem } from './_shared'

/**
 * Drift for API roles: compare the declared policy/rule NAME sets against the
 * role's live attachment (translated back to names for a readable diff).
 * Best-effort — if the manager can't be listed at all, no drift is raised.
 * Extra live roles not declared here are not flagged (same
 * no-cross-resource-pruning philosophy as the other config types).
 */
interface WazuhRole {
  id: number
  name: string
  policies: number[]
  rules: number[]
}
interface WazuhNamedResource {
  id: number
  name: string
}

function setDiff(declared: string[], live: string[]): { missing: string[]; extra: string[] } {
  const declaredSet = new Set(declared)
  const liveSet = new Set(live)
  return {
    missing: declared.filter((n) => !liveSet.has(n)),
    extra: live.filter((n) => !declaredSet.has(n)),
  }
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  let baseUrl: string
  let auth: Record<string, string>
  try {
    const resolved = await getToken(component, connectivity, connectivityProvider, credential)
    baseUrl = resolved.baseUrl
    auth = bearerHeader(resolved.token)
  } catch {
    return { hasDrift: false, diffs }
  }

  let roles: WazuhRole[]
  let policiesById: Map<number, string>
  let rulesById: Map<number, string>
  try {
    roles = await listAffectedItems<WazuhRole>(baseUrl, auth, '/security/roles')
    policiesById = new Map((await listAffectedItems<WazuhNamedResource>(baseUrl, auth, '/security/policies')).map((p) => [p.id, p.name]))
    rulesById = new Map((await listAffectedItems<WazuhNamedResource>(baseUrl, auth, '/security/rules')).map((r) => [r.id, r.name]))
  } catch {
    return { hasDrift: false, diffs }
  }
  const rolesByName = new Map(roles.map((r) => [r.name, r]))

  for (const item of items) {
    const spec = specFromItem(item)
    if (!spec.name) continue

    const found = rolesByName.get(spec.name)
    if (!found) {
      diffs.push({ field: `${spec.name}`, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const livePolicyNames = found.policies.map((id) => policiesById.get(id) ?? `#${id}`)
    const policyDiff = setDiff(spec.policyNames, livePolicyNames)
    if (policyDiff.missing.length || policyDiff.extra.length) {
      diffs.push({
        field: `${spec.name}.policies`,
        expected: spec.policyNames,
        actual: livePolicyNames,
        severity: 'warning',
      })
    }

    const liveRuleNames = found.rules.map((id) => rulesById.get(id) ?? `#${id}`)
    const ruleDiff = setDiff(spec.ruleNames, liveRuleNames)
    if (ruleDiff.missing.length || ruleDiff.extra.length) {
      diffs.push({
        field: `${spec.name}.rules`,
        expected: spec.ruleNames,
        actual: liveRuleNames,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
