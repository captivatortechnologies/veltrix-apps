import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonicalDefinition, extractTokenLifetimeSpecs, type LiveTokenLifetimePolicy } from './validate'
import { buildPolicyTargetMaps, listPolicyAppliesTo, resolvePolicyTargets } from '../lib/policyAppliesTo'

const BASE = '/policies/tokenLifetimePolicies'
const SELECT = '?$select=id,displayName,definition,isOrganizationDefault'
const POLICY_TYPE_NAME = 'tokenLifetimePolicies'
const ALLOWED_KINDS = ['servicePrincipal'] as const

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractTokenLifetimeSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveTokenLifetimePolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p])
  )
  const targetMaps = await buildPolicyTargetMaps(client)

  const diffs: Diffs = []
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
    const wantDefault = spec.isOrganizationDefault
    const liveDefault = live.isOrganizationDefault === true
    if (wantDefault !== liveDefault) {
      diffs.push({
        field: `${spec.name}.isOrganizationDefault`,
        expected: String(wantDefault),
        actual: String(liveDefault),
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
