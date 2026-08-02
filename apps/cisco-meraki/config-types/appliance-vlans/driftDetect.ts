import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, listVlans } from '../../lib/merakiApi'
import { canonicalJson, pickKeys } from '../../lib/merakiCommon'
import { buildVlanBody, declaredVlanKeys, extractVlanSpecs, parseJsonObject, type MerakiVlan } from './_shared'

/**
 * Detect drift for appliance VLANs: for each declared (network, id) pair,
 * find the live VLAN by id and compare ONLY the keys we declare (typed fields
 * + `advanced` keys) against the live object — so Meraki's server-injected
 * defaults raise no false drift. A VLAN we declare but that no longer exists
 * is critical drift; a changed value is a warning. Best-effort per network.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractVlanSpecs(ctx.deployedConfig).filter((s) => s.networkId && s.id)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const liveByNetwork = new Map<string, MerakiVlan[] | null>()
  const loadNetwork = async (networkId: string): Promise<MerakiVlan[] | null> => {
    if (liveByNetwork.has(networkId)) return liveByNetwork.get(networkId)!
    let live: MerakiVlan[] | null
    try {
      live = await listVlans(client, networkId)
    } catch {
      live = null
    }
    liveByNetwork.set(networkId, live)
    return live
  }

  for (const spec of specs) {
    const label = `${spec.networkId}/${spec.id}`
    const live = await loadNetwork(spec.networkId)
    if (live === null) continue

    const match = live.find((v) => String(v.id ?? '').trim() === spec.id)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const { value: advanced } = parseJsonObject(spec.advancedRaw, 'advanced')
    if (!advanced) continue

    const keys = declaredVlanKeys(spec, advanced)
    const expected = pickKeys(buildVlanBody(spec, advanced, false), keys)
    const actual = pickKeys(match, keys)
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      diffs.push({ field: `${label}.settings`, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
