import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractPolicySpecs, mapCanvasStateToGraph, type LiveCaPolicy } from './validate'
import {
  buildGroupNameToId,
  buildUserNameToId,
  buildRoleNameToId,
  buildLocationNameToId,
  buildAuthStrengthNameToId,
  buildTermsOfUseNameToId,
  resolveGroups,
  resolveUsers,
  resolveRoles,
  resolveLocations,
  resolveTermsOfUse,
  resolveAuthenticationStrength,
} from './deploy'

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
  const groupNameToId = await buildGroupNameToId(client)
  const userNameToId = await buildUserNameToId(client)
  const roleNameToId = await buildRoleNameToId(client)
  const locationNameToId = await buildLocationNameToId(client)
  const authStrengthNameToId = await buildAuthStrengthNameToId(client)
  const termsOfUseNameToId = await buildTermsOfUseNameToId(client)

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

    // users / groups / roles
    const liveUsers = live.conditions?.users ?? {}
    const inc = resolveGroups(spec.includeAllUsers ? [] : spec.includeGroups, groupNameToId)
    const exc = resolveGroups(spec.excludeGroups, groupNameToId)
    const incUsers = resolveUsers(spec.includeAllUsers ? [] : spec.includeUsers, userNameToId)
    const excUsers = resolveUsers(spec.excludeUsers, userNameToId)
    const incRoles = resolveRoles(spec.includeAllUsers ? [] : spec.includeRoles, roleNameToId)
    const excRoles = resolveRoles(spec.excludeRoles, roleNameToId)

    const unresolvedUsers = [
      ...inc.missing,
      ...exc.missing,
      ...incUsers.missing,
      ...excUsers.missing,
      ...incRoles.missing,
      ...excRoles.missing,
    ]
    if (unresolvedUsers.length) {
      diffs.push({
        field: `${spec.name}.users`,
        expected: 'resolvable',
        actual: `unknown group/user/role: ${unresolvedUsers.join(', ')}`,
        severity: 'critical',
      })
    }

    const wantIncludeUsers = spec.includeAllUsers ? ['All'] : incUsers.ids
    if (sortedJson(liveUsers.includeUsers ?? []) !== sortedJson(wantIncludeUsers)) {
      diffs.push({
        field: `${spec.name}.includeUsers`,
        expected: wantIncludeUsers,
        actual: liveUsers.includeUsers ?? [],
        severity: 'warning',
      })
    }
    if (sortedJson(liveUsers.excludeUsers ?? []) !== sortedJson(excUsers.ids)) {
      diffs.push({
        field: `${spec.name}.excludeUsers`,
        expected: excUsers.ids,
        actual: liveUsers.excludeUsers ?? [],
        severity: 'warning',
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
    const wantIncludeRoles = spec.includeAllUsers ? [] : incRoles.ids
    if (sortedJson(liveUsers.includeRoles ?? []) !== sortedJson(wantIncludeRoles)) {
      diffs.push({
        field: `${spec.name}.includeRoles`,
        expected: wantIncludeRoles,
        actual: liveUsers.includeRoles ?? [],
        severity: 'warning',
      })
    }
    if (sortedJson(liveUsers.excludeRoles ?? []) !== sortedJson(excRoles.ids)) {
      diffs.push({
        field: `${spec.name}.excludeRoles`,
        expected: excRoles.ids,
        actual: liveUsers.excludeRoles ?? [],
        severity: 'warning',
      })
    }

    // locations
    const liveLocations = live.conditions?.locations ?? {}
    const incLocations = resolveLocations(spec.includeLocations, locationNameToId)
    const excLocations = resolveLocations(spec.excludeLocations, locationNameToId)
    const unresolvedLocations = [...incLocations.missing, ...excLocations.missing]
    if (unresolvedLocations.length) {
      diffs.push({
        field: `${spec.name}.locations`,
        expected: 'resolvable',
        actual: `unknown location(s): ${unresolvedLocations.join(', ')}`,
        severity: 'critical',
      })
    }
    if (sortedJson(liveLocations.includeLocations ?? []) !== sortedJson(incLocations.ids)) {
      diffs.push({
        field: `${spec.name}.includeLocations`,
        expected: incLocations.ids,
        actual: liveLocations.includeLocations ?? [],
        severity: 'warning',
      })
    }
    if (sortedJson(liveLocations.excludeLocations ?? []) !== sortedJson(excLocations.ids)) {
      diffs.push({
        field: `${spec.name}.excludeLocations`,
        expected: excLocations.ids,
        actual: liveLocations.excludeLocations ?? [],
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

    const authStrength = resolveAuthenticationStrength(spec.authenticationStrength, authStrengthNameToId)
    if (authStrength.missing) {
      diffs.push({
        field: `${spec.name}.authenticationStrength`,
        expected: 'resolvable',
        actual: `unknown authentication strength: ${spec.authenticationStrength}`,
        severity: 'critical',
      })
    }
    const liveAuthStrengthId = live.grantControls?.authenticationStrength?.id ?? ''
    if (liveAuthStrengthId !== authStrength.id) {
      diffs.push({
        field: `${spec.name}.authenticationStrength`,
        expected: authStrength.id,
        actual: liveAuthStrengthId,
        severity: 'warning',
      })
    }

    const termsOfUse = resolveTermsOfUse(spec.termsOfUse, termsOfUseNameToId)
    if (termsOfUse.missing.length) {
      diffs.push({
        field: `${spec.name}.termsOfUse`,
        expected: 'resolvable',
        actual: `unknown terms of use: ${termsOfUse.missing.join(', ')}`,
        severity: 'critical',
      })
    }
    const liveTermsOfUse = live.grantControls?.termsOfUse ?? []
    if (sortedJson(liveTermsOfUse) !== sortedJson(termsOfUse.ids)) {
      diffs.push({
        field: `${spec.name}.termsOfUse`,
        expected: termsOfUse.ids,
        actual: liveTermsOfUse,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
