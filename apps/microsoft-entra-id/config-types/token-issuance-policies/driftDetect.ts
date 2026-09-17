import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonicalDefinition, extractTokenIssuanceSpecs, type LiveTokenIssuancePolicy } from './validate'
import { buildPolicyTargetMaps, listPolicyAppliesTo, resolvePolicyTargets } from '../lib/policyAppliesTo'

const BASE = '/policies/tokenIssuancePolicies'
const SELECT = '?$select=id,displayName,definition'
const POLICY_TYPE_NAME = 'tokenIssuancePolicies'
const ALLOWED_KINDS = ['application'] as const

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildGraphClient(cred, settings)

  const specs = extractTokenIssuanceSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveTokenIssuancePolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [], checked: false }
  const liveByName = new Map(
    listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p]),
  )
  const targetMaps = await buildPolicyTargetMaps(client)

  const diffs: Diffs = []
  // Set when an object could not be read. The run then reports `checked: false`
  // rather than "in sync": the platform treats `hasDrift: false` as verified
  // and clears any outstanding drift record for the component.
  let checkedAll = true
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const wantDefinition = canonicalDefinition(spec.definition)
    const liveDefinition = canonicalDefinition((live.definition ?? [])[0] ?? '')
    if (wantDefinition !== liveDefinition) {
      diffs.push({
        field: `${spec.name}.definition`,
        expected: wantDefinition ?? '',
        actual: liveDefinition ?? '',
        severity: 'warning',
      })
    }

    if (!live.id) continue
    const targetResolution = resolvePolicyTargets(spec.appliesTo, targetMaps, ALLOWED_KINDS)
    if (targetResolution.missing.length) {
      diffs.push({
        field: `${spec.name}.appliesTo`,
        expected: 'resolvable',
        actual: `unknown target(s): ${targetResolution.missing.join(', ')}`,
        severity: 'critical',
      })
      continue
    }
    const liveAppliesTo = await listPolicyAppliesTo(client, POLICY_TYPE_NAME, live.id)
    if (!liveAppliesTo.ok) {
      checkedAll = false
      continue
    }
    const liveIds = new Set(liveAppliesTo.targets.map((t) => t.id))
    const declaredIds = targetResolution.targets.map((t) => t.id)
    const missingLive = declaredIds.filter((id) => !liveIds.has(id))
    if (missingLive.length) {
      diffs.push({
        field: `${spec.name}.appliesTo`,
        expected: sortedJson(declaredIds),
        actual: sortedJson([...liveIds]),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs, ...(checkedAll ? {} : { checked: false }) }
}
