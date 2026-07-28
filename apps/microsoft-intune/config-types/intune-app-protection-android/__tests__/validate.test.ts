import validate, { extractProtectionSpecs, policyKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import {
  ANDROID_APP_PROTECTION_ODATA_TYPE,
  buildProtectionBody,
  buildTargetAppsBody,
  capturePriorFields,
} from '../appProtection'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-app-protection-android',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-app-protection-android',
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

describe('Intune Android App Protection Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a selectedPublicApps policy with targeted apps and an assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: {
            name: 'Corp Android MAM',
            appGroupType: 'selectedPublicApps',
            targetedApps: ['com.microsoft.emmx', 'com.microsoft.office.outlook'],
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

  it('requires at least one app when targeting selected public apps', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { name: 'x', appGroupType: 'selectedPublicApps', allUsers: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_targeted_apps')).toBe(true)
  })

  it('rejects an unknown data-transfer enum value', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: { name: 'x', appGroupType: 'allApps', allUsers: true, allowedInboundDataTransferSources: 'bogus' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('rejects a PIN length out of range', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { name: 'x', appGroupType: 'allApps', allUsers: true, minimumPinLength: 20 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'out_of_range')).toBe(true)
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

  it('warns when a policy has no assignment target', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { name: 'Unassigned', appGroupType: 'allApps' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_assignment')).toBe(true)
  })

  it('warns when targeted apps are set but the group type ignores them', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: { name: 'AllApps', appGroupType: 'allApps', targetedApps: ['com.microsoft.emmx'], allUsers: true },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'ignored_targeted_apps')).toBe(true)
  })
})

describe('extractProtectionSpecs', () => {
  it('reads name, settings, app group type, targeted apps and assignment', () => {
    const specs = extractProtectionSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            name: '  Corp MAM  ',
            description: '  android baseline  ',
            pinRequired: true,
            minimumPinLength: '6',
            allowedOutboundClipboardSharingLevel: 'managedApps',
            screenCaptureBlocked: true,
            appGroupType: 'selectedPublicApps',
            targetedApps: 'com.microsoft.emmx, com.microsoft.office.outlook',
            includeGroups: ['g1', 'g2'],
            excludeGroups: ['g3'],
            allUsers: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Corp MAM')
    expect(specs[0].description).toBe('android baseline')
    expect(specs[0].settings.pinRequired).toBe(true)
    expect(specs[0].settings.minimumPinLength).toBe(6)
    expect(specs[0].settings.allowedOutboundClipboardSharingLevel).toBe('managedApps')
    expect(specs[0].settings.screenCaptureBlocked).toBe(true)
    expect(specs[0].appGroupType).toBe('selectedPublicApps')
    expect(specs[0].targetedApps).toEqual(['com.microsoft.emmx', 'com.microsoft.office.outlook'])
    expect(specs[0].assignment.includeGroupIds).toEqual(['g1', 'g2'])
    expect(specs[0].assignment.excludeGroupIds).toEqual(['g3'])
    expect(specs[0].assignment.allUsers).toBe(true)
    expect(specs[0].assignment.allDevices).toBe(false)
  })

  it('defaults the app group type to selectedPublicApps for an unknown value', () => {
    const specs = extractProtectionSpecs(
      makeCtx([{ name: 'p', fields: { name: 'x', appGroupType: 'garbage' } }]).canvas,
    )
    expect(specs[0].appGroupType).toBe('selectedPublicApps')
  })

  it('policyKey trims and lowercases', () => {
    expect(policyKey('  Corp MAM ')).toBe('corp mam')
  })
})

describe('buildProtectionBody', () => {
  it('builds a body with the @odata.type, identity, always-sent checkboxes and set scalars', () => {
    const specs = extractProtectionSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            name: 'MAM',
            description: 'd',
            pinRequired: true,
            minimumPinLength: 6,
            allowedOutboundClipboardSharingLevel: 'managedApps',
            screenCaptureBlocked: true,
            encryptAppData: false,
            minimumRequiredOsVersion: '11.0',
          },
        },
      ]).canvas,
    )
    const body = buildProtectionBody(specs[0]) as Record<string, unknown>
    expect(body['@odata.type']).toBe(ANDROID_APP_PROTECTION_ODATA_TYPE)
    expect(body.displayName).toBe('MAM')
    expect(body.description).toBe('d')
    expect(body.roleScopeTagIds).toEqual(['0'])
    expect(body.pinRequired).toBe(true)
    expect(body.minimumPinLength).toBe(6)
    expect(body.allowedOutboundClipboardSharingLevel).toBe('managedApps')
    expect(body.screenCaptureBlocked).toBe(true)
    // A checkbox is always sent, even when false.
    expect(body.encryptAppData).toBe(false)
    expect(body.minimumRequiredOsVersion).toBe('11.0')
    // An unset number is omitted (left unmanaged).
    expect(body.maximumPinRetries).toBeUndefined()
  })

  it('omits an enum whose value is not a known option', () => {
    const specs = extractProtectionSpecs(
      makeCtx([{ name: 'p', fields: { name: 'MAM', allowedInboundDataTransferSources: 'bogus' } }]).canvas,
    )
    const body = buildProtectionBody(specs[0]) as Record<string, unknown>
    expect(body.allowedInboundDataTransferSources).toBeUndefined()
  })
})

describe('buildTargetAppsBody', () => {
  it('emits androidMobileAppIdentifier packageIds for selectedPublicApps', () => {
    const specs = extractProtectionSpecs(
      makeCtx([
        { name: 'p', fields: { name: 'MAM', appGroupType: 'selectedPublicApps', targetedApps: ['com.microsoft.emmx'] } },
      ]).canvas,
    )
    const body = buildTargetAppsBody(specs[0])
    expect(body.appGroupType).toBe('selectedPublicApps')
    expect(body.apps).toHaveLength(1)
    const identifier = body.apps[0].mobileAppIdentifier as Record<string, unknown>
    expect(identifier['@odata.type']).toBe('#microsoft.graph.androidMobileAppIdentifier')
    expect(identifier.packageId).toBe('com.microsoft.emmx')
  })

  it('sends no apps for a non-selectedPublicApps group type', () => {
    const specs = extractProtectionSpecs(
      makeCtx([
        { name: 'p', fields: { name: 'MAM', appGroupType: 'allApps', targetedApps: ['com.microsoft.emmx'] } },
      ]).canvas,
    )
    const body = buildTargetAppsBody(specs[0])
    expect(body.appGroupType).toBe('allApps')
    expect(body.apps).toHaveLength(0)
  })
})

describe('capturePriorFields', () => {
  it('captures identity and the managed fields present on a live policy', () => {
    const prior = capturePriorFields({
      id: 'abc',
      '@odata.type': ANDROID_APP_PROTECTION_ODATA_TYPE,
      displayName: 'MAM',
      description: 'live',
      roleScopeTagIds: ['0'],
      pinRequired: true,
      minimumPinLength: 8,
      screenCaptureBlocked: false,
    })
    expect(prior.displayName).toBe('MAM')
    expect(prior.description).toBe('live')
    expect(prior.pinRequired).toBe(true)
    expect(prior.minimumPinLength).toBe(8)
    expect(prior.screenCaptureBlocked).toBe(false)
    // A field the live policy did not return is not captured.
    expect(prior.maximumPinRetries).toBeUndefined()
  })
})
