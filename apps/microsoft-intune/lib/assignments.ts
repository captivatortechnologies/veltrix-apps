// =============================================================================
// Shared Intune Graph assignment-payload builder.
//
// Every Intune policy (compliance, configuration, update ring, app protection,
// …) is created WITHOUT assignments, then assigned via a separate `assign`
// action: POST /deviceManagement/<collection>/{id}/assign with body
// { assignments: [{ target: { "@odata.type": …, groupId?, filter… } }] }.
// Targets: groupAssignmentTarget (include), exclusionGroupAssignmentTarget
// (exclude), allDevicesAssignmentTarget, allLicensedUsersAssignmentTarget.
// Assignment filters attach to include/all targets only. This module builds and
// reads back that payload so every structured policy type shares one code path.
// =============================================================================

export interface AssignmentSpec {
  includeGroupIds: string[]
  excludeGroupIds: string[]
  allDevices?: boolean
  allUsers?: boolean
  /** Assignment filter id applied to include/all targets (optional). */
  filterId?: string
  /** How the filter applies. Defaults to 'include' when a filterId is set. */
  filterType?: 'include' | 'exclude'
}

export interface GraphAssignment {
  target: Record<string, unknown>
}

/** Filter props for an include/all target, or empty when no filter is set. */
function filterProps(spec: AssignmentSpec): Record<string, unknown> {
  if (!spec.filterId) return {}
  return {
    deviceAndAppManagementAssignmentFilterId: spec.filterId,
    deviceAndAppManagementAssignmentFilterType: spec.filterType ?? 'include',
  }
}

/** Build the `assignments` array for an `assign` action body. */
export function buildAssignments(spec: AssignmentSpec): GraphAssignment[] {
  const assignments: GraphAssignment[] = []
  if (spec.allDevices) {
    assignments.push({
      target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget', ...filterProps(spec) },
    })
  }
  if (spec.allUsers) {
    assignments.push({
      target: {
        '@odata.type': '#microsoft.graph.allLicensedUsersAssignmentTarget',
        ...filterProps(spec),
      },
    })
  }
  for (const groupId of spec.includeGroupIds) {
    assignments.push({
      target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId, ...filterProps(spec) },
    })
  }
  // Exclusions never carry a filter.
  for (const groupId of spec.excludeGroupIds) {
    assignments.push({
      target: { '@odata.type': '#microsoft.graph.exclusionGroupAssignmentTarget', groupId },
    })
  }
  return assignments
}

/**
 * Read the include/exclude group ids + all-devices/all-users flags off a live
 * policy's `assignments` array (order-insensitive) so deploy/drift can converge
 * to the declared set.
 */
export function readAssignments(
  assignments: Array<{ target?: Record<string, unknown> }> | undefined,
): { includeGroupIds: string[]; excludeGroupIds: string[]; allDevices: boolean; allUsers: boolean } {
  const includeGroupIds: string[] = []
  const excludeGroupIds: string[] = []
  let allDevices = false
  let allUsers = false
  for (const a of assignments ?? []) {
    const target = a.target ?? {}
    const odata = String(target['@odata.type'] ?? '')
    const groupId = typeof target.groupId === 'string' ? target.groupId : undefined
    if (odata.includes('allDevicesAssignmentTarget')) allDevices = true
    else if (odata.includes('allLicensedUsersAssignmentTarget')) allUsers = true
    else if (odata.includes('exclusionGroupAssignmentTarget')) {
      if (groupId) excludeGroupIds.push(groupId)
    } else if (odata.includes('groupAssignmentTarget')) {
      if (groupId) includeGroupIds.push(groupId)
    }
  }
  return { includeGroupIds, excludeGroupIds, allDevices, allUsers }
}
