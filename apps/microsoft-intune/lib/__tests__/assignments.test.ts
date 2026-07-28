import { buildAssignments, readAssignments } from '../assignments'

describe('buildAssignments', () => {
  it('builds include group targets with a filter and exclude targets without one', () => {
    const out = buildAssignments({
      includeGroupIds: ['g1', 'g2'],
      excludeGroupIds: ['g3'],
      filterId: 'f1',
      filterType: 'include',
    })
    expect(out).toHaveLength(3)
    expect(out[0].target['@odata.type']).toBe('#microsoft.graph.groupAssignmentTarget')
    expect(out[0].target.groupId).toBe('g1')
    expect(out[0].target.deviceAndAppManagementAssignmentFilterId).toBe('f1')
    expect(out[0].target.deviceAndAppManagementAssignmentFilterType).toBe('include')
    // Exclusion carries no filter.
    expect(out[2].target['@odata.type']).toBe('#microsoft.graph.exclusionGroupAssignmentTarget')
    expect(out[2].target.deviceAndAppManagementAssignmentFilterId).toBeUndefined()
  })

  it('builds all-devices / all-users targets', () => {
    const out = buildAssignments({ includeGroupIds: [], excludeGroupIds: [], allDevices: true, allUsers: true })
    expect(out).toHaveLength(2)
    expect(out[0].target['@odata.type']).toBe('#microsoft.graph.allDevicesAssignmentTarget')
    expect(out[1].target['@odata.type']).toBe('#microsoft.graph.allLicensedUsersAssignmentTarget')
  })

  it('defaults filterType to include when a filterId is given without a type', () => {
    const out = buildAssignments({ includeGroupIds: ['g1'], excludeGroupIds: [], filterId: 'f1' })
    expect(out[0].target.deviceAndAppManagementAssignmentFilterType).toBe('include')
  })
})

describe('readAssignments', () => {
  it('reads include/exclude group ids and all-* flags off a live assignments array', () => {
    const live = [
      { target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'g1' } },
      { target: { '@odata.type': '#microsoft.graph.exclusionGroupAssignmentTarget', groupId: 'g3' } },
      { target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } },
    ]
    const r = readAssignments(live)
    expect(r.includeGroupIds).toEqual(['g1'])
    expect(r.excludeGroupIds).toEqual(['g3'])
    expect(r.allDevices).toBe(true)
    expect(r.allUsers).toBe(false)
  })

  it('tolerates an empty/undefined assignments array', () => {
    const r = readAssignments(undefined)
    expect(r.includeGroupIds).toHaveLength(0)
    expect(r.allDevices).toBe(false)
  })
})
