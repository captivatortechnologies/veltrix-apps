import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractPolicySpecs, mapCanvasStateToGraph, type LiveCaPolicy } from './validate'
import { buildGroupNameToId, resolveGroups } from './deploy'

const BASE = '/identity/conditionalAccess/policies'

type Diffs = DriftResult['diffs']

function sortedJson(v: unknown[]): string {
  return JSON.stringify([...v].map((x) => String(x)).sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveCaPolicy>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p])
  )
  const nameToId = await buildGroupNameToId(client)

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    // state
    const wantState = mapCanvasStateToGraph(spec.state)
    if ((live.state ?? '') !== wantState) {
      diffs.push({ field: `${spec.name}.state`, expected: wantState, actual: live.state ?? '', severity: 'critical' })
    }

    // users
    const liveUsers = live.conditions?.users ?? {}
    const wantIncludeUsers = spec.includeAllUsers ? ['All'] : []
    if (sortedJson(liveUsers.includeUsers ?? []) !== sortedJson(wantIncludeUsers)) {
      diffs.push({
        field: `${spec.name}.includeUsers`,
        expected: wantIncludeUsers,
        actual: liveUsers.includeUsers ?? [],
        severity: 'warning',
      })
    }
    const inc = resolveGroups(spec.includeAllUsers ? [] : spec.includeGroups, nameToId)
    const exc = resolveGroups(spec.excludeGroups, nameToId)
    if (inc.missing.length || exc.missing.length) {
      diffs.push({
        field: `${spec.name}.groups`,
        expected: 'resolvable',
        actual: `unknown groups: ${[...inc.missing, ...exc.missing].join(', ')}`,
        severity: 'critical',
      })
    }
    if (sortedJson(liveUsers.includeGroups ?? []) !== sortedJson(inc.ids)) {
      diffs.push({
        field: `${spec.name}.includeGroups`,
        expected: inc.ids,
        actual: liveUsers.includeGroups ?? [],
        severity: 'warning',
      })
    }
    if (sortedJson(liveUsers.excludeGroups ?? []) !== sortedJson(exc.ids)) {
      diffs.push({
        field: `${spec.name}.excludeGroups`,
        expected: exc.ids,
        actual: liveUsers.excludeGroups ?? [],
        severity: 'warning',
      })
    }

    // applications
    const liveApps = live.conditions?.applications?.includeApplications ?? []
    const wantApps = spec.includeAllApps ? ['All'] : spec.includeApps
    if (sortedJson(liveApps) !== sortedJson(wantApps)) {
      diffs.push({
        field: `${spec.name}.includeApplications`,
        expected: wantApps,
        actual: liveApps,
        severity: 'warning',
      })
    }

    // grant controls
    const liveOperator = live.grantControls?.operator ?? ''
    if (liveOperator !== spec.grantOperator) {
      diffs.push({
        field: `${spec.name}.grantOperator`,
        expected: spec.grantOperator,
        actual: liveOperator,
        severity: 'warning',
      })
    }
    const liveControls = live.grantControls?.builtInControls ?? []
    if (sortedJson(liveControls) !== sortedJson(spec.builtInControls)) {
      diffs.push({
        field: `${spec.name}.builtInControls`,
        expected: [...spec.builtInControls].sort(),
        actual: [...liveControls].sort(),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
