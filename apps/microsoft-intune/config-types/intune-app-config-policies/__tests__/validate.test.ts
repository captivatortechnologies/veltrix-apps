import validate, { extractAppConfigSpecs, policyKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import {
  APP_CONFIG_ODATA_TYPE,
  KEY_VALUE_PAIR_ODATA_TYPE,
  buildAssignBody,
  buildConfigBody,
  buildTargetAppsBody,
  parseCustomSettings,
  readLiveAppGroupType,
  readLiveAssignment,
  readLiveCustomSettings,
  readLiveTargetedApps,
  sameCustomSettings,
} from '../appConfig'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-app-config-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-app-config-policies',
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

describe('Intune App Configuration Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a policy with a name, custom settings, targeted app and assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: {
            name: 'Outlook Config',
            platform: 'ios',
            customSettings: 'com.microsoft.outlook.EmailProfile.AccountType=ModernAuth',
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
    const result = await validate(makeCtx([{ name: 'p', fields: { appGroupType: 'allApps', customSettings: 'a=b', allUsers: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate policy names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Baseline', appGroupType: 'allApps', customSettings: 'a=b', allUsers: true } },
        { name: 'b', fields: { name: 'BASELINE', appGroupType: 'allApps', customSettings: 'a=b', allUsers: true } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('requires at least one targeted app when the group is selectedPublicApps', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'X', appGroupType: 'selectedPublicApps', customSettings: 'a=b', allUsers: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'targeted_apps_required')).toBe(true)
  })

  it('does not require targeted apps when the group is allApps', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'X', appGroupType: 'allApps', customSettings: 'a=b', allUsers: true } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects custom settings that are not valid JSON or key=value lines', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'X', appGroupType: 'allApps', customSettings: 'this is not valid', allUsers: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_custom_settings')).toBe(true)
  })

  it('rejects a JSON custom-settings value that is not an array', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'X', appGroupType: 'allApps', customSettings: '{"name":"a","value":"b"}', allUsers: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_custom_settings')).toBe(true)
  })

  it('warns when a policy has no custom settings', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'Empty', appGroupType: 'allApps', allUsers: true } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_custom_settings')).toBe(true)
  })

  it('warns when a policy has no assignment target', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { name: 'Unassigned', appGroupType: 'allApps', customSettings: 'a=b' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_assignment')).toBe(true)
  })

  it('warns when targeted apps are set but the app group ignores them', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { name: 'X', appGroupType: 'allApps', customSettings: 'a=b', targetedApps: ['com.a'], allUsers: true } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'ignored_targeted_apps')).toBe(true)
  })
})

describe('parseCustomSettings', () => {
  it('parses key=value lines into name/value pairs', () => {
    const parsed = parseCustomSettings('a=1\nb = two\nc=with=equals')
    expect(parsed.error).toBeUndefined()
    expect(parsed.settings).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'two' },
      { name: 'c', value: 'with=equals' },
    ])
  })

  it('parses a JSON array of { name, value } objects and coerces values to strings', () => {
    const parsed = parseCustomSettings('[{"name":"a","value":"1"},{"name":"flag","value":true},{"name":"n","value":5}]')
    expect(parsed.error).toBeUndefined()
    expect(parsed.settings).toEqual([
      { name: 'a', value: '1' },
      { name: 'flag', value: 'true' },
      { name: 'n', value: '5' },
    ])
  })

  it('accepts a pre-structured array value', () => {
    const parsed = parseCustomSettings([{ name: 'a', value: 'b' }])
    expect(parsed.settings).toEqual([{ name: 'a', value: 'b' }])
  })

  it('returns an empty result for blank input with no error', () => {
    const parsed = parseCustomSettings('   ')
    expect(parsed.settings).toHaveLength(0)
    expect(parsed.error).toBeUndefined()
  })

  it('errors on a key=value line missing an equals sign', () => {
    const parsed = parseCustomSettings('novalue')
    expect(parsed.settings).toHaveLength(0)
    expect(parsed.error).toMatch(/key=value/)
  })

  it('errors on malformed JSON', () => {
    const parsed = parseCustomSettings('[{"name":"a"')
    expect(parsed.settings).toHaveLength(0)
    expect(parsed.error).toMatch(/valid JSON/)
  })

  it('errors on a JSON array entry missing a name', () => {
    const parsed = parseCustomSettings('[{"value":"b"}]')
    expect(parsed.settings).toHaveLength(0)
    expect(parsed.error).toMatch(/name/)
  })

  it('errors on a duplicate custom setting name', () => {
    const parsed = parseCustomSettings('a=1\na=2')
    expect(parsed.settings).toHaveLength(0)
    expect(parsed.error).toMatch(/Duplicate/)
  })
})

describe('extractAppConfigSpecs', () => {
  it('reads name/description/platform, app group, targeted apps, custom settings and assignment', () => {
    const specs = extractAppConfigSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            name: '  Corp Config  ',
            description: '  corp appconfig  ',
            platform: 'android',
            customSettings: 'k1=v1\nk2=v2',
            appGroupType: 'selectedPublicApps',
            targetedApps: 'com.a, com.b',
            includeGroups: ['g1'],
            excludeGroups: 'g2',
            allUsers: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Corp Config')
    expect(specs[0].description).toBe('corp appconfig')
    expect(specs[0].platform).toBe('android')
    expect(specs[0].appGroupType).toBe('selectedPublicApps')
    expect(specs[0].targetedApps).toEqual(['com.a', 'com.b'])
    expect(specs[0].customSettings).toEqual([
      { name: 'k1', value: 'v1' },
      { name: 'k2', value: 'v2' },
    ])
    expect(specs[0].assignment.includeGroupIds).toEqual(['g1'])
    expect(specs[0].assignment.excludeGroupIds).toEqual(['g2'])
    expect(specs[0].assignment.allUsers).toBe(true)
    expect(specs[0].assignment.allDevices).toBe(false)
  })

  it('defaults an unknown/blank platform to ios and app group to selectedPublicApps', () => {
    const specs = extractAppConfigSpecs(makeCtx([{ name: 'p', fields: { name: 'X' } }]).canvas)
    expect(specs[0].platform).toBe('ios')
    expect(specs[0].appGroupType).toBe('selectedPublicApps')
  })

  it('surfaces a custom-settings parse error on the spec', () => {
    const specs = extractAppConfigSpecs(makeCtx([{ name: 'p', fields: { name: 'X', customSettings: 'bogus line' } }]).canvas)
    expect(specs[0].customSettingsError).toBeDefined()
  })

  it('policyKey trims and lowercases', () => {
    expect(policyKey('  Corp Config ')).toBe('corp config')
  })
})

describe('body builders', () => {
  it('buildConfigBody carries the @odata.type + customSettings but never appGroupType/apps/assignments', () => {
    const specs = extractAppConfigSpecs(
      makeCtx([{ name: 'p', fields: { name: 'Corp', description: 'd', platform: 'ios', customSettings: 'a=1\nb=2', appGroupType: 'selectedPublicApps', targetedApps: ['com.a'], includeGroups: ['g1'] } }]).canvas,
    )
    const body = buildConfigBody(specs[0]) as Record<string, unknown>
    expect(body['@odata.type']).toBe(APP_CONFIG_ODATA_TYPE)
    expect(body.displayName).toBe('Corp')
    expect(body.description).toBe('d')
    expect(body.roleScopeTagIds).toEqual(['0'])
    const settings = body.customSettings as Array<Record<string, unknown>>
    expect(settings).toHaveLength(2)
    expect(settings[0]['@odata.type']).toBe(KEY_VALUE_PAIR_ODATA_TYPE)
    expect(settings[0].name).toBe('a')
    expect(settings[0].value).toBe('1')
    // Apps + assignments + appGroupType are bound by their own actions, never on the body.
    expect(body.appGroupType).toBeUndefined()
    expect(body.apps).toBeUndefined()
    expect(body.assignments).toBeUndefined()
  })

  it('buildTargetAppsBody emits iOS bundle-id identifiers for an iOS policy', () => {
    const specs = extractAppConfigSpecs(makeCtx([{ name: 'p', fields: { name: 'X', platform: 'ios', appGroupType: 'selectedPublicApps', targetedApps: ['com.a', 'com.b'] } }]).canvas)
    const body = buildTargetAppsBody(specs[0]) as { appGroupType: string; apps: Array<{ mobileAppIdentifier: Record<string, unknown> }> }
    expect(body.appGroupType).toBe('selectedPublicApps')
    expect(body.apps).toHaveLength(2)
    expect(body.apps[0].mobileAppIdentifier['@odata.type']).toBe('#microsoft.graph.iosMobileAppIdentifier')
    expect(body.apps[0].mobileAppIdentifier.bundleId).toBe('com.a')
  })

  it('buildTargetAppsBody emits Android package-id identifiers for an Android policy', () => {
    const specs = extractAppConfigSpecs(makeCtx([{ name: 'p', fields: { name: 'X', platform: 'android', appGroupType: 'selectedPublicApps', targetedApps: ['com.a'] } }]).canvas)
    const body = buildTargetAppsBody(specs[0]) as { appGroupType: string; apps: Array<{ mobileAppIdentifier: Record<string, unknown> }> }
    expect(body.apps[0].mobileAppIdentifier['@odata.type']).toBe('#microsoft.graph.androidMobileAppIdentifier')
    expect(body.apps[0].mobileAppIdentifier.packageId).toBe('com.a')
  })

  it('buildTargetAppsBody sends no apps for a non-selected app group', () => {
    const specs = extractAppConfigSpecs(makeCtx([{ name: 'p', fields: { name: 'X', platform: 'ios', appGroupType: 'allMicrosoftApps', targetedApps: ['com.a'] } }]).canvas)
    const body = buildTargetAppsBody(specs[0]) as { appGroupType: string; apps: unknown[] }
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

  it('readLiveCustomSettings reads name/value pairs and drops blank names', () => {
    const settings = readLiveCustomSettings({
      customSettings: [
        { name: 'a', value: '1' },
        { name: '', value: 'x' },
        { name: 'b', value: 2 },
      ],
    })
    expect(settings).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ])
  })

  it('readLiveTargetedApps reads bundle ids for ios and package ids for android', () => {
    const iosIds = readLiveTargetedApps(
      { apps: [{ mobileAppIdentifier: { '@odata.type': '#microsoft.graph.iosMobileAppIdentifier', bundleId: 'com.a' } }] },
      'ios',
    )
    expect(iosIds).toEqual(['com.a'])
    const androidIds = readLiveTargetedApps(
      { apps: [{ mobileAppIdentifier: { '@odata.type': '#microsoft.graph.androidMobileAppIdentifier', packageId: 'com.b' } }] },
      'android',
    )
    expect(androidIds).toEqual(['com.b'])
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

  it('sameCustomSettings is order-insensitive by name and value-sensitive', () => {
    expect(sameCustomSettings([{ name: 'a', value: '1' }, { name: 'b', value: '2' }], [{ name: 'b', value: '2' }, { name: 'a', value: '1' }])).toBe(true)
    expect(sameCustomSettings([{ name: 'a', value: '1' }], [{ name: 'a', value: '2' }])).toBe(false)
    expect(sameCustomSettings([{ name: 'a', value: '1' }], [])).toBe(false)
  })
})
