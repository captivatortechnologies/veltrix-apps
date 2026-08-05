import validate, {
  buildProfileBody,
  extractProfileSpecs,
  hasAnyAssignment,
  readApprovalType,
  profileKey,
  APPROVAL_TYPES,
  DRIVER_UPDATE_PROFILE_ODATA_TYPE,
} from '../validate'
import { normalizePriorApprovalType } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-driver-update-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-driver-update-profiles',
      items: [],
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000', azure_cloud: 'commercial' },
    platform: stubPlatform,
  }
}

describe('Intune Driver Update Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a manual profile with a name and an assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: {
            profile_name: 'Manual Review',
            approvalType: 'manual',
            includeGroups: ['11111111-1111-1111-1111-111111111111'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('validates an automatic profile with an in-range deferral', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: { profile_name: 'Auto Approve', approvalType: 'automatic', deploymentDeferralInDays: 7, allDevices: true },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('requires a profile name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { approvalType: 'manual', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate profile names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { profile_name: 'Drivers', approvalType: 'manual', allDevices: true } },
        { name: 'b', fields: { profile_name: 'DRIVERS', approvalType: 'manual', allDevices: true } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_profile')).toBe(true)
  })

  it('rejects an unrecognized approval type', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { profile_name: 'Bad', approvalType: 'sometimes', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_approval_type')).toBe(true)
  })

  it('rejects a negative deferral', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { profile_name: 'Bad', approvalType: 'automatic', deploymentDeferralInDays: -1, allDevices: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })

  it('rejects a non-integer deferral', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { profile_name: 'Bad', approvalType: 'automatic', deploymentDeferralInDays: 2.5, allDevices: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })

  it('warns when a deferral is set but approval type is manual (ignored)', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { profile_name: 'Confused', approvalType: 'manual', deploymentDeferralInDays: 5, allDevices: true } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'ignored_when_manual')).toBe(true)
  })

  it('warns when a profile targets nothing', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { profile_name: 'Orphan', approvalType: 'manual' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_assignment')).toBe(true)
  })
})

describe('extractProfileSpecs', () => {
  it('reads name/description/approval/deferral and assignments', () => {
    const specs = extractProfileSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            profile_name: '  Auto Approve  ',
            description: '  rush drivers out  ',
            approvalType: 'automatic',
            deploymentDeferralInDays: 3,
            includeGroups: 'g1, g2',
            excludeGroups: ['g3'],
            allDevices: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Auto Approve')
    expect(specs[0].description).toBe('rush drivers out')
    expect(specs[0].approvalType).toBe('automatic')
    expect(specs[0].deploymentDeferralInDays).toBe(3)
    expect(specs[0].assignments.includeGroupIds).toEqual(['g1', 'g2'])
    expect(specs[0].assignments.excludeGroupIds).toEqual(['g3'])
    expect(specs[0].assignments.allDevices).toBe(true)
    // Driver update profiles target devices only — never users.
    expect(specs[0].assignments.allUsers).toBe(false)
  })

  it('omits a blank deferral (left unmanaged)', () => {
    const specs = extractProfileSpecs(makeCtx([{ name: 'p', fields: { profile_name: 'M', approvalType: 'manual' } }]).canvas)
    expect(specs[0].deploymentDeferralInDays).toBeUndefined()
  })

  it('profileKey trims and lowercases', () => {
    expect(profileKey('  Auto Approve ')).toBe('auto approve')
  })

  it('readApprovalType defaults blank to manual but preserves an unrecognized value for validate to reject', () => {
    expect(readApprovalType(undefined)).toBe('manual')
    expect(readApprovalType('')).toBe('manual')
    expect(readApprovalType('automatic')).toBe('automatic')
    expect(readApprovalType('bogus')).toBe('bogus')
    expect(APPROVAL_TYPES).toEqual(['manual', 'automatic'])
  })

  it('hasAnyAssignment reflects declared targets', () => {
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(false)
    expect(hasAnyAssignment({ includeGroupIds: ['g1'], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(true)
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: true, allUsers: false })).toBe(true)
  })
})

describe('buildProfileBody', () => {
  it('builds a create/PATCH body carrying the odata type and deferral when automatic', () => {
    const specs = extractProfileSpecs(
      makeCtx([{ name: 'p', fields: { profile_name: 'Auto', description: 'd', approvalType: 'automatic', deploymentDeferralInDays: 5 } }])
        .canvas,
    )
    const body = buildProfileBody(specs[0])
    expect(body['@odata.type']).toBe(DRIVER_UPDATE_PROFILE_ODATA_TYPE)
    expect(body.displayName).toBe('Auto')
    expect(body.description).toBe('d')
    expect(body.roleScopeTagIds).toEqual(['0'])
    expect(body.approvalType).toBe('automatic')
    expect(body.deploymentDeferralInDays).toBe(5)
  })

  it('omits deploymentDeferralInDays when approval type is manual, even if a value was set', () => {
    const specs = extractProfileSpecs(
      makeCtx([{ name: 'p', fields: { profile_name: 'Manual', approvalType: 'manual', deploymentDeferralInDays: 5 } }]).canvas,
    )
    const body = buildProfileBody(specs[0])
    expect(body.approvalType).toBe('manual')
    expect(body.deploymentDeferralInDays).toBeUndefined()
  })

  it('omits deploymentDeferralInDays when automatic but no value was set', () => {
    const specs = extractProfileSpecs(makeCtx([{ name: 'p', fields: { profile_name: 'Auto', approvalType: 'automatic' } }]).canvas)
    const body = buildProfileBody(specs[0])
    expect(body.deploymentDeferralInDays).toBeUndefined()
  })
})

describe('deploy helpers', () => {
  it('normalizePriorApprovalType accepts only the two known values', () => {
    expect(normalizePriorApprovalType('manual')).toBe('manual')
    expect(normalizePriorApprovalType('automatic')).toBe('automatic')
    expect(normalizePriorApprovalType('unknown')).toBeUndefined()
    expect(normalizePriorApprovalType(undefined)).toBeUndefined()
  })
})
