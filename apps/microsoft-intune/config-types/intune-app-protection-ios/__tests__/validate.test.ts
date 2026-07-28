import validate, { extractIosMamSpecs, policyKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import {
  buildAssignBody,
  buildPolicyBody,
  buildTargetAppsBody,
  capturePriorFields,
  readLiveAppGroupType,
  readLiveAssignment,
  readLiveTargetedApps,
  IOS_MANAGED_APP_PROTECTION_ODATA_TYPE,
} from '../iosAppProtection'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-app-protection-ios',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-app-protection-ios',
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

describe('Intune iOS App Protection Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a policy with a name, targeted app and assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: {
            name: 'Outlook Protection',
            pinRequired: true,
            minimumPinLength: 6,
            allowedOutboundClipboardSharingLevel: 'managedApps',
            appGroupType: 'selectedPublicApps',
            targetedApps: ['com.microsoft.office.outlook'],
            includeGroups: ['11111111-1111-1111-1111-111111111111'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('requires a policy name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { appGroupType: 'allApps', allUsers: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate policy names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Baseline', appGroupType: 'allApps', allUsers: true } },
        { name: 'b', fields: { name: 'BASELINE', appGroupType: 'allApps', allUsers: true } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('requires at least one targeted app when the group is selectedPublicApps', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'X', appGroupType: 'selectedPublicApps', allUsers: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'targeted_apps_required')).toBe(true)
  })

  it('does not require targeted apps when the group is allApps', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'X', appGroupType: 'allApps', allUsers: true } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an unknown enum value', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { name: 'X', appGroupType: 'allApps', allowedInboundDataTransferSources: 'bogus', allUsers: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('rejects a PIN retry count out of range', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { name: 'X', appGroupType: 'allApps', maximumPinRetries: 70000, allUsers: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })

  it('rejects a minimum PIN length below the lower bound', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { name: 'X', appGroupType: 'allApps', minimumPinLength: 0, allUsers: true } }]),
    )
    expect(result.valid).toBe(false)
    const err = result.errors.find((e) => e.code === 'out_of_range')
    expect(err).toBeDefined()
    expect(err?.message).toContain('1 or greater')
  })

  it('warns when a policy has no assignment target', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'Unassigned', appGroupType: 'allApps' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_assignment')).toBe(true)
  })
})

describe('extractIosMamSpecs', () => {
  it('reads name/description, managed scalars, app group, targeted apps and assignment; omits blank fields', () => {
    const specs = extractIosMamSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            name: '  Corp Baseline  ',
            description: '  corp mam  ',
            pinRequired: true,
            minimumPinLength: '6',
            allowedOutboundClipboardSharingLevel: 'managedApps',
            appGroupType: 'selectedPublicApps',
            targetedApps: 'com.a, com.b',
            includeGroups: ['g1'],
            excludeGroups: 'g2',
            allUsers: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Corp Baseline')
    expect(specs[0].description).toBe('corp mam')
    expect(specs[0].graph.pinRequired).toBe(true)
    expect(specs[0].graph.minimumPinLength).toBe(6)
    expect(specs[0].graph.allowedOutboundClipboardSharingLevel).toBe('managedApps')
    // A field the user did not set is omitted (left unmanaged).
    expect(specs[0].graph.maximumPinRetries).toBeUndefined()
    expect(specs[0].appGroupType).toBe('selectedPublicApps')
    expect(specs[0].targetedApps).toEqual(['com.a', 'com.b'])
    expect(specs[0].assignment.includeGroupIds).toEqual(['g1'])
    expect(specs[0].assignment.excludeGroupIds).toEqual(['g2'])
    expect(specs[0].assignment.allUsers).toBe(true)
    expect(specs[0].assignment.allDevices).toBe(false)
  })

  it('defaults an unknown/blank app group to selectedPublicApps', () => {
    const specs = extractIosMamSpecs(makeCtx([{ name: 'p', fields: { name: 'X' } }]).canvas)
    expect(specs[0].appGroupType).toBe('selectedPublicApps')
  })

  it('policyKey trims and lowercases', () => {
    expect(policyKey('  Corp Baseline ')).toBe('corp baseline')
  })
})

describe('body builders', () => {
  it('buildPolicyBody carries the @odata.type + scalars but never the apps/appGroupType/assignments', () => {
    const specs = extractIosMamSpecs(
      makeCtx([{ name: 'p', fields: { name: 'Corp', description: 'd', pinRequired: true, minimumPinLength: 6, appGroupType: 'selectedPublicApps', targetedApps: ['com.a'], includeGroups: ['g1'] } }]).canvas,
    )
    const body = buildPolicyBody(specs[0]) as Record<string, unknown>
    expect(body['@odata.type']).toBe(IOS_MANAGED_APP_PROTECTION_ODATA_TYPE)
    expect(body.displayName).toBe('Corp')
    expect(body.description).toBe('d')
    expect(body.roleScopeTagIds).toEqual(['0'])
    expect(body.pinRequired).toBe(true)
    expect(body.minimumPinLength).toBe(6)
    // Apps + assignments + appGroupType are bound by their own actions, never on the body.
    expect(body.appGroupType).toBeUndefined()
    expect(body.apps).toBeUndefined()
    expect(body.assignments).toBeUndefined()
  })

  it('buildTargetAppsBody emits iOS bundle-id identifiers for selectedPublicApps', () => {
    const body = buildTargetAppsBody('selectedPublicApps', ['com.a', 'com.b']) as {
      appGroupType: string
      apps: Array<{ mobileAppIdentifier: Record<string, unknown> }>
    }
    expect(body.appGroupType).toBe('selectedPublicApps')
    expect(body.apps).toHaveLength(2)
    expect(body.apps[0].mobileAppIdentifier['@odata.type']).toBe('#microsoft.graph.iosMobileAppIdentifier')
    expect(body.apps[0].mobileAppIdentifier.bundleId).toBe('com.a')
  })

  it('buildTargetAppsBody sends no apps for a non-selected app group', () => {
    const body = buildTargetAppsBody('allMicrosoftApps', ['com.a']) as { appGroupType: string; apps: unknown[] }
    expect(body.appGroupType).toBe('allMicrosoftApps')
    expect(body.apps).toHaveLength(0)
  })

  it('buildAssignBody builds include/exclude group + all-users targets', () => {
    const body = buildAssignBody({ includeGroupIds: ['g1'], excludeGroupIds: ['g2'], allDevices: false, allUsers: true }) as {
      assignments: Array<{ target: Record<string, unknown> }>
    }
    expect(body.assignments).toHaveLength(3)
    const types = body.assignments.map((a) => String(a.target['@odata.type']))
    expect(types.some((t) => t.includes('allLicensedUsersAssignmentTarget'))).toBe(true)
    expect(types.some((t) => t.includes('groupAssignmentTarget'))).toBe(true)
    expect(types.some((t) => t.includes('exclusionGroupAssignmentTarget'))).toBe(true)
  })
})

describe('live-policy readers (drift / rollback)', () => {
  it('readLiveAppGroupType returns the live value or defaults to selectedPublicApps', () => {
    expect(readLiveAppGroupType({ appGroupType: 'allApps' })).toBe('allApps')
    expect(readLiveAppGroupType({})).toBe('selectedPublicApps')
    expect(readLiveAppGroupType(null)).toBe('selectedPublicApps')
  })

  it('readLiveTargetedApps reads bundle ids off the apps collection', () => {
    const ids = readLiveTargetedApps({
      apps: [
        { mobileAppIdentifier: { '@odata.type': '#microsoft.graph.iosMobileAppIdentifier', bundleId: 'com.a' } },
        { mobileAppIdentifier: { '@odata.type': '#microsoft.graph.iosMobileAppIdentifier', bundleId: 'com.b' } },
      ],
    })
    expect(ids).toEqual(['com.a', 'com.b'])
  })

  it('readLiveAssignment reads include/exclude groups and all-users', () => {
    const a = readLiveAssignment({
      assignments: [
        { target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'g1' } },
        { target: { '@odata.type': '#microsoft.graph.exclusionGroupAssignmentTarget', groupId: 'g2' } },
        { target: { '@odata.type': '#microsoft.graph.allLicensedUsersAssignmentTarget' } },
      ],
    })
    expect(a.includeGroupIds).toEqual(['g1'])
    expect(a.excludeGroupIds).toEqual(['g2'])
    expect(a.allUsers).toBe(true)
  })

  it('capturePriorFields keeps managed scalars and drops server-managed state', () => {
    const captured = capturePriorFields({
      '@odata.type': IOS_MANAGED_APP_PROTECTION_ODATA_TYPE,
      id: 'abc',
      displayName: 'Corp',
      pinRequired: true,
      minimumPinLength: 6,
      allowedOutboundClipboardSharingLevel: 'managedApps',
      version: '3',
      lastModifiedDateTime: '2026-01-01T00:00:00Z',
    })
    expect(captured.pinRequired).toBe(true)
    expect(captured.minimumPinLength).toBe(6)
    expect(captured.allowedOutboundClipboardSharingLevel).toBe('managedApps')
    expect(captured.version).toBeUndefined()
    expect(captured.lastModifiedDateTime).toBeUndefined()
  })
})
