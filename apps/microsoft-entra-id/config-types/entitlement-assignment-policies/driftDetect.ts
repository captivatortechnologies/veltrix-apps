import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonical, extractAssignmentPolicySpecs, type LiveAssignmentPolicy } from './validate'
import {
  buildConnectedOrganizationNameToId,
  buildGroupNameToId,
  buildServicePrincipalNameToId,
  buildUserNameToId,
  resolveRefs,
} from '../lib/nameMaps'
import {
  buildApprovalSettings,
  buildRequestorSettings,
  buildSpecificAllowedTargets,
  type ResolvedTargets,
} from './deploy'

const BASE = '/identityGovernance/entitlementManagement/assignmentPolicies'
const SELECT =
  '?$select=id,displayName,description,allowedTargetScope,expiration,specificAllowedTargets,requestorSettings,requestApprovalSettings'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAssignmentPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAssignmentPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p]))

  const [user, group, servicePrincipal, connectedOrganization] = await Promise.all([
    buildUserNameToId(client),
    buildGroupNameToId(client),
    buildServicePrincipalNameToId(client),
    buildConnectedOrganizationNameToId(client),
  ])
  // accessPackage binding is matched by NAME only (see deploy.ts) — a policy
  // is never re-bound to a different package by PATCH, so it isn't diffed here.

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.allowedTargetScope !== (live.allowedTargetScope ?? '')) {
      diffs.push({
        field: `${spec.name}.allowedTargetScope`,
        expected: spec.allowedTargetScope,
        actual: live.allowedTargetScope ?? '',
        severity: 'warning',
      })
    }

    const targets: ResolvedTargets = {
      users: resolveRefs(spec.specificTargetUsers, user).ids,
      groups: resolveRefs(spec.specificTargetGroups, group).ids,
      servicePrincipals: resolveRefs(spec.specificTargetServicePrincipals, servicePrincipal).ids,
      connectedOrganizations: resolveRefs(spec.specificTargetConnectedOrganizations, connectedOrganization).ids,
    }
    const wantTargets = canonical(buildSpecificAllowedTargets(targets))
    const actualTargets = canonical(live.specificAllowedTargets ?? [])
    if (wantTargets !== actualTargets) {
      diffs.push({ field: `${spec.name}.specificAllowedTargets`, expected: wantTargets, actual: actualTargets, severity: 'warning' })
    }

    const onBehalf = {
      users: resolveRefs(spec.onBehalfRequestorUsers, user).ids,
      groups: resolveRefs(spec.onBehalfRequestorGroups, group).ids,
      servicePrincipals: resolveRefs(spec.onBehalfRequestorServicePrincipals, servicePrincipal).ids,
    }
    const wantRequestor = canonical(buildRequestorSettings(spec, onBehalf))
    const actualRequestor = canonical(live.requestorSettings ?? {})
    if (wantRequestor !== actualRequestor) {
      diffs.push({ field: `${spec.name}.requestorSettings`, expected: wantRequestor, actual: actualRequestor, severity: 'warning' })
    }

    const approvers = {
      users: resolveRefs(spec.primaryApproverUsers, user).ids,
      groups: resolveRefs(spec.primaryApproverGroups, group).ids,
    }
    const wantApproval = canonical(buildApprovalSettings(spec, approvers))
    const actualApproval = canonical(live.requestApprovalSettings ?? {})
    if (wantApproval !== actualApproval) {
      diffs.push({ field: `${spec.name}.requestApprovalSettings`, expected: wantApproval, actual: actualApproval, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
