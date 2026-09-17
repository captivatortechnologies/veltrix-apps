import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDuoClient, canonicalJson, readDuoSettings, resolveDuoCredential } from '../../lib/duo'
import { extractPolicySpecs, parseSections, type LivePolicy } from './validate'

const BASE = '/admin/v2/policies'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildDuoClient(cred, settings)

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAllV5<LivePolicy>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [], checked: false }
  const liveByName = new Map(listed.items.filter((p) => p.policy_name).map((p) => [p.policy_name!.toLowerCase(), p]))

  const diffs: Diffs = []
  // Set when an object could not be read. The run then reports `checked: false`
  // rather than "in sync": the platform treats `hasDrift: false` as verified
  // and clears any outstanding drift record for the component.
  let checkedAll = true
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live?.policy_key) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const parsed = parseSections(spec.sectionsRaw)
    if (!parsed.ok || !parsed.value) continue
    const desired = parsed.value
    if (Object.keys(desired).length === 0) continue

    const detail = await client.getV5(`${BASE}/${live.policy_key}`)
    if (!detail.ok) {
      checkedAll = false
      continue
    }
    const liveSections = ((detail.response as LivePolicy | null)?.sections ?? {}) as Record<string, unknown>

    for (const key of Object.keys(desired)) {
      if (canonicalJson(desired[key]) !== canonicalJson(liveSections[key])) {
        diffs.push({
          field: `${spec.name}.sections.${key}`,
          expected: canonicalJson(desired[key]),
          actual: canonicalJson(liveSections[key] ?? null),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs, ...(checkedAll ? {} : { checked: false }) }
}
