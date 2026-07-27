import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, parseJson, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import type { LivePolicySummary } from '../policies/validate'
import { extractBlockSpecs, type LiveBlock } from './validate'
import { definitionEquals } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const base = client.deviceControlPath('blocks')

  const specs = extractBlockSpecs(ctx.deployedConfig).filter((s) => s.policyName)

  const policyRes = await client.get(`${client.policiesPath()}/summary`)
  if (!policyRes.ok) return { hasDrift: false, diffs: [] }
  const policyParsed = parseJson<{ policies?: LivePolicySummary[] } | LivePolicySummary[]>(policyRes.body)
  const policies = Array.isArray(policyParsed) ? policyParsed : policyParsed?.policies ?? []
  const policyIdByName = new Map<string, string>()
  for (const p of policies) if (p.name && p.id !== undefined && p.id !== null) policyIdByName.set(p.name.toLowerCase(), String(p.id))

  const blocksRes = await client.get(base)
  if (!blocksRes.ok) return { hasDrift: false, diffs: [] }
  const blocksParsed = parseJson<{ results?: LiveBlock[] } | LiveBlock[]>(blocksRes.body)
  const blocks = Array.isArray(blocksParsed) ? blocksParsed : blocksParsed?.results ?? []
  const liveByPolicy = new Map<string, LiveBlock>()
  for (const b of blocks) if (b.policy_id !== undefined && b.policy_id !== null) liveByPolicy.set(String(b.policy_id), b)

  const diffs: Diffs = []
  for (const spec of specs) {
    const policyId = policyIdByName.get(spec.policyName.toLowerCase())
    const live = policyId ? liveByPolicy.get(policyId) : undefined
    if (!live) {
      diffs.push({ field: spec.policyName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!definitionEquals(live, spec)) {
      const ad = live.windows?.approved_devices ?? {}
      if ((ad.allow_write ?? false) !== spec.allowWrite) {
        diffs.push({ field: `${spec.policyName}.allow_write`, expected: spec.allowWrite, actual: ad.allow_write ?? false, severity: 'warning' })
      }
      if ((ad.allow_execute ?? false) !== spec.allowExecute) {
        diffs.push({ field: `${spec.policyName}.allow_execute`, expected: spec.allowExecute, actual: ad.allow_execute ?? false, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
