import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, listGroupPolicies } from '../../lib/merakiApi'
import { canonicalJson, pickKeys } from '../../lib/merakiCommon'
import {
  buildGroupPolicyBody,
  declaredGroupPolicyKeys,
  extractGroupPolicySpecs,
  groupPolicyKey,
  parseJsonObject,
  type MerakiGroupPolicy,
} from './_shared'

/**
 * Detect drift for group policies: for each declared (network, name) pair,
 * find the live policy by name and compare ONLY the keys we declare (`name` +
 * every key in the `policy` JSON blob) against the live object — so Meraki's
 * server-injected defaults for fields we never set raise no false drift. A
 * policy we declare but that no longer exists is critical drift; a changed
 * value is a warning. Best-effort per network: an unreadable network raises no
 * false drift for the items that target it.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractGroupPolicySpecs(ctx.deployedConfig).filter((s) => s.networkId && s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const liveByNetwork = new Map<string, MerakiGroupPolicy[] | null>()
  const loadNetwork = async (networkId: string): Promise<MerakiGroupPolicy[] | null> => {
    if (liveByNetwork.has(networkId)) return liveByNetwork.get(networkId)!
    let live: MerakiGroupPolicy[] | null
    try {
      live = await listGroupPolicies(client, networkId)
    } catch {
      live = null
    }
    liveByNetwork.set(networkId, live)
    return live
  }

  for (const spec of specs) {
    const label = `${spec.networkId}/${spec.name}`
    const live = await loadNetwork(spec.networkId)
    if (live === null) continue

    const match = live.find((p) => p.name && groupPolicyKey(p.name) === groupPolicyKey(spec.name))
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const { value: policy } = parseJsonObject(spec.policyRaw, 'policy')
    if (!policy) continue

    const keys = declaredGroupPolicyKeys(policy)
    const expected = pickKeys(buildGroupPolicyBody(spec.name, policy), keys)
    const actual = pickKeys(match, keys)
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      diffs.push({ field: `${label}.policy`, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
