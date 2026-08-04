// unifiedRoleAssignment is immutable, so there is no field-level drift — the only
// drift is a declared assignment tuple that is missing from the directory (critical).
import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { assignmentKey, extractRoleAssignmentSpecs, type LiveRoleAssignment } from './validate'
import { buildRoleNameToId, resolveRef } from '../lib/nameMaps'
import { buildPrincipalNameMaps, resolvePrincipal } from '../lib/principals'
import { buildDirectoryScopeNameMaps, resolveDirectoryScope } from '../lib/directoryScope'

const BASE = '/roleManagement/directory/roleAssignments'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractRoleAssignmentSpecs(ctx.deployedConfig).filter((s) => s.roleDefinitionId && s.principalId)
  const listed = await client.getAll<LiveRoleAssignment>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByKey = new Map(listed.items.filter((a) => a.id).map((a) => [assignmentKey(a), a]))

  const [role, principal, scope] = await Promise.all([
    buildRoleNameToId(client),
    buildPrincipalNameMaps(client),
    buildDirectoryScopeNameMaps(client),
  ])

  const diffs: Diffs = []
  for (const spec of specs) {
    const roleRef = resolveRef(spec.roleDefinitionId, role)
    const principalRef = resolvePrincipal(spec.principalId, principal)
    const scopeRef = resolveDirectoryScope(spec.directoryScopeId, scope)
    const label = spec.label || `${spec.roleDefinitionId} -> ${spec.principalId}`
    const missing = [
      ...(roleRef.missing ? [spec.roleDefinitionId] : []),
      ...(principalRef.missing ? [spec.principalId] : []),
      ...(scopeRef.missing ? [scopeRef.missing] : []),
    ]
    if (missing.length) {
      diffs.push({
        field: label,
        expected: 'resolvable',
        actual: `unknown target(s): ${missing.join(', ')}`,
        severity: 'critical',
      })
      continue
    }

    const key = assignmentKey({ roleDefinitionId: roleRef.id, principalId: principalRef.id, directoryScopeId: scopeRef.scope })
    if (!liveByKey.has(key)) {
      // A truncated listing can't prove absence — skip the (false) critical.
      if (listed.truncated) continue
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
    }
  }

  if (listed.truncated) {
    diffs.push({
      field: '(role-assignment listing)',
      expected: 'complete',
      actual: `truncated at ${listed.items.length}+ assignments — absence of declared assignments not verified`,
      severity: 'info',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
