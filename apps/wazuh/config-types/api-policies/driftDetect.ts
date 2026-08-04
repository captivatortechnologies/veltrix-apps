import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, listAffectedItems } from '../../lib/wazuhApi'
import { specFromItem, policyBodyEquals } from './_shared'

/**
 * Drift for API policies: compare the declared actions/resources/effect against
 * the live policy of the same name. Best-effort — if the manager can't be
 * listed at all, no drift is raised (surfaced at deploy/health instead). A
 * declared policy missing live is one diff; a live policy whose body differs is
 * another. Extra live policies not declared here are not flagged (same
 * no-cross-resource-pruning philosophy as the other config types).
 */
interface WazuhPolicy {
  id: number
  name: string
  policy: { actions: string[]; resources: string[]; effect: string }
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

  let live: WazuhPolicy[]
  try {
    live = await listAffectedItems<WazuhPolicy>(baseUrl, auth, '/security/policies')
  } catch {
    return { hasDrift: false, diffs }
  }
  const byName = new Map(live.map((p) => [p.name, p]))

  for (const item of items) {
    const spec = specFromItem(item)
    if (!spec.name) continue

    const found = byName.get(spec.name)
    if (!found) {
      diffs.push({ field: `${spec.name}`, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const declared = { actions: spec.actions, resources: spec.resources, effect: spec.effect }
    if (!policyBodyEquals(declared, found.policy)) {
      diffs.push({ field: `${spec.name}.policy`, expected: declared, actual: found.policy, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
