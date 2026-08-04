import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, listAffectedItems } from '../../lib/wazuhApi'
import { specFromItem, ruleEquals } from './_shared'

/**
 * Drift for RBAC rules: compare the declared `rule` JSON (key-order-insensitive)
 * against the live rule of the same name. Best-effort — if the manager can't be
 * listed at all, no drift is raised. Extra live rules not declared here are not
 * flagged (same no-cross-resource-pruning philosophy as the other config types).
 */
interface WazuhRbacRule {
  id: number
  name: string
  rule: Record<string, unknown>
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

  let live: WazuhRbacRule[]
  try {
    live = await listAffectedItems<WazuhRbacRule>(baseUrl, auth, '/security/rules')
  } catch {
    return { hasDrift: false, diffs }
  }
  const byName = new Map(live.map((r) => [r.name, r]))

  for (const item of items) {
    const spec = specFromItem(item)
    if (!spec.name || !spec.rule) continue

    const found = byName.get(spec.name)
    if (!found) {
      diffs.push({ field: `${spec.name}`, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    if (!ruleEquals(spec.rule, found.rule)) {
      diffs.push({ field: `${spec.name}.rule`, expected: spec.rule, actual: found.rule, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
