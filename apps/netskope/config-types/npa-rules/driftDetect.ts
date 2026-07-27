import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractRuleSpecs, trimBrackets, type LiveRule, type RuleSpec } from './validate'

const BASE = '/policy/npa/rules'
const LIST_KEY = 'rules'

type Diffs = DriftResult['diffs']

function sortedSig(tokens: string[]): string {
  return [...tokens].map((t) => trimBrackets(t)).sort().join(',')
}

function liveEnabled(live: LiveRule): boolean {
  return live.enabled === true || live.enabled === '1'
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAllNpa<LiveRule>(BASE, LIST_KEY)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((r) => r.rule_name).map((r) => [r.rule_name!.toLowerCase(), r]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (liveEnabled(live) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(liveEnabled(live)), severity: 'warning' })
    }
    const liveAction = live.rule_data?.match_criteria_action?.action_name ?? ''
    if (liveAction !== spec.action) {
      diffs.push({ field: `${spec.name}.action`, expected: spec.action, actual: liveAction, severity: 'warning' })
    }
    const expectedApps = sortedSig(spec.privateApps)
    const actualApps = sortedSig(live.rule_data?.private_apps ?? [])
    if (expectedApps !== actualApps) {
      diffs.push({ field: `${spec.name}.private_apps`, expected: expectedApps, actual: actualApps, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
