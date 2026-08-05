import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonical, extractAppManagementSpecs, parseObject, type LiveAppManagementPolicy } from './validate'
import { buildPolicyTargetMaps, listPolicyAppliesTo, resolvePolicyTargets } from '../lib/policyAppliesTo'

const BASE = '/policies/appManagementPolicies'
const SELECT = '?$select=id,displayName,description,isEnabled,restrictions'
const POLICY_TYPE_NAME = 'appManagementPolicies'
const ALLOWED_KINDS = ['application', 'servicePrincipal'] as const

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAppManagementSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAppManagementPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p]),
  )
  const targetMaps = await buildPolicyTargetMaps(client)

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.isEnabled !== (live.isEnabled === true)) {
      diffs.push({
        field: `${spec.name}.isEnabled`,
        expected: String(spec.isEnabled),
        actual: String(live.isEnabled === true),
        severity: 'warning',
      })
    }
    const wantRestrictions = canonical(parseObject(spec.restrictions) ?? {})
    const liveRestrictions = canonical(live.restrictions ?? {})
    if (wantRestrictions !== liveRestrictions) {
      diffs.push({
        field: `${spec.name}.restrictions`,
        expected: wantRestrictions,
        actual: liveRestrictions,
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
    if (!liveAppliesTo.ok) continue
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

  return { hasDrift: diffs.length > 0, diffs }
}
