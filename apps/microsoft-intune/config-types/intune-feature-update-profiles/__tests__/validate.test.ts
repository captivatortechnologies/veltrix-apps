import validate, {
  buildProfileBody,
  buildRolloutSettings,
  extractProfileSpecs,
  hasAnyAssignment,
  hasAnyRollout,
  normalizeDateTime,
  profileKey,
  readRolloutSettings,
  WINDOWS_FEATURE_UPDATE_PROFILE_ODATA_TYPE,
  WINDOWS_UPDATE_ROLLOUT_SETTINGS_ODATA_TYPE,
} from '../validate'
import { captureManagedFields } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-feature-update-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-feature-update-profiles',
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

describe('Intune Feature Update Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a profile with a name, feature version and an assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: {
            profile_name: 'Pilot 23H2',
            featureUpdateVersion: 'Windows 11, version 23H2',
            includeGroups: ['11111111-1111-1111-1111-111111111111'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('requires a profile name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { featureUpdateVersion: 'Windows 11, version 23H2', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a feature update version', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { profile_name: 'No Version', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('featureUpdateVersion'))).toBe(true)
  })

  it('rejects duplicate profile names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { profile_name: 'Broad', featureUpdateVersion: 'Windows 11, version 23H2', allDevices: true } },
        { name: 'b', fields: { profile_name: 'BROAD', featureUpdateVersion: 'Windows 11, version 23H2', allDevices: true } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_profile')).toBe(true)
  })

  it('rejects a rollout end date that is not after the start date', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: {
            profile_name: 'Bad window',
            featureUpdateVersion: 'Windows 11, version 23H2',
            rolloutStartDate: '2026-09-10T00:00:00Z',
            rolloutEndDate: '2026-09-01T00:00:00Z',
            allDevices: true,
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'rollout_window')).toBe(true)
  })

  it('rejects an unparseable rollout date', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: { profile_name: 'Bad date', featureUpdateVersion: 'Windows 11, version 23H2', rolloutStartDate: 'not-a-date', allDevices: true },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_datetime')).toBe(true)
  })

  it('rejects a rollout interval below 1', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: { profile_name: 'Bad interval', featureUpdateVersion: 'Windows 11, version 23H2', rolloutIntervalInDays: 0, allDevices: true },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })

  it('warns when an interval is set without a start/end window', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: { profile_name: 'Partial', featureUpdateVersion: 'Windows 11, version 23H2', rolloutIntervalInDays: 5, allDevices: true },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'gradual_rollout_incomplete')).toBe(true)
  })

  it('warns when a profile targets nothing', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { profile_name: 'Orphan', featureUpdateVersion: 'Windows 11, version 23H2' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_assignment')).toBe(true)
  })
})

describe('extractProfileSpecs', () => {
  it('reads name/description, managed fields, rollout and assignments; omits blank fields', () => {
    const specs = extractProfileSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            profile_name: '  Pilot  ',
            description: '  broad pilot  ',
            featureUpdateVersion: '  Windows 11, version 24H2  ',
            installLatestWindows10OnWindows11IneligibleDevice: true,
            rolloutStartDate: '2026-09-01T00:00:00Z',
            rolloutIntervalInDays: 7,
            includeGroups: 'g1, g2',
            excludeGroups: ['g3'],
            allDevices: false,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Pilot')
    expect(specs[0].description).toBe('broad pilot')
    expect(specs[0].graph.featureUpdateVersion).toBe('Windows 11, version 24H2')
    expect(specs[0].graph.installLatestWindows10OnWindows11IneligibleDevice).toBe(true)
    expect(specs[0].rollout.startDate).toBe('2026-09-01T00:00:00Z')
    expect(specs[0].rollout.intervalInDays).toBe(7)
    // A rollout field the user did not set is left undefined (unmanaged).
    expect(specs[0].rollout.endDate).toBeUndefined()
    expect(specs[0].assignments.includeGroupIds).toEqual(['g1', 'g2'])
    expect(specs[0].assignments.excludeGroupIds).toEqual(['g3'])
    expect(specs[0].assignments.allDevices).toBe(false)
  })

  it('omits the install flag when the user did not set it', () => {
    const specs = extractProfileSpecs(
      makeCtx([{ name: 'p', fields: { profile_name: 'P', featureUpdateVersion: 'Windows 11, version 23H2' } }]).canvas,
    )
    expect(specs[0].graph.installLatestWindows10OnWindows11IneligibleDevice).toBeUndefined()
  })

  it('profileKey trims and lowercases', () => {
    expect(profileKey('  Pilot Ring ')).toBe('pilot ring')
  })

  it('hasAnyAssignment reflects declared targets', () => {
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(false)
    expect(hasAnyAssignment({ includeGroupIds: ['g1'], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(true)
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: true, allUsers: false })).toBe(true)
  })

  it('hasAnyRollout reflects declared rollout fields', () => {
    expect(hasAnyRollout({})).toBe(false)
    expect(hasAnyRollout({ startDate: '2026-09-01T00:00:00Z' })).toBe(true)
    expect(hasAnyRollout({ intervalInDays: 3 })).toBe(true)
  })
})

describe('buildRolloutSettings and readRolloutSettings', () => {
  it('returns undefined when no rollout field is set', () => {
    expect(buildRolloutSettings({})).toBeUndefined()
  })

  it('builds the complex type with the offer fields, nulling those left unset', () => {
    const rollout = buildRolloutSettings({ startDate: '2026-09-01T00:00:00Z' }) as Record<string, unknown>
    expect(rollout['@odata.type']).toBe(WINDOWS_UPDATE_ROLLOUT_SETTINGS_ODATA_TYPE)
    expect(rollout.offerStartDateTimeInUTC).toBe('2026-09-01T00:00:00Z')
    expect(rollout.offerEndDateTimeInUTC).toBeNull()
    expect(rollout.offerIntervalInDays).toBeNull()
  })

  it('reads the three offer fields off a live rolloutSettings, defaulting missing to null', () => {
    const read = readRolloutSettings({ offerStartDateTimeInUTC: '2026-09-01T00:00:00Z', offerIntervalInDays: 5 })
    expect(read.offerStartDateTimeInUTC).toBe('2026-09-01T00:00:00Z')
    expect(read.offerIntervalInDays).toBe(5)
    expect(read.offerEndDateTimeInUTC).toBeNull()
  })

  it('reads a null/absent rolloutSettings as all-null offers', () => {
    const read = readRolloutSettings(null)
    expect(read.offerStartDateTimeInUTC).toBeNull()
    expect(read.offerEndDateTimeInUTC).toBeNull()
    expect(read.offerIntervalInDays).toBeNull()
  })
})

describe('normalizeDateTime', () => {
  it('normalizes a parseable timestamp to ISO', () => {
    expect(normalizeDateTime('2026-09-01T00:00:00Z')).toBe('2026-09-01T00:00:00.000Z')
  })

  it('treats null, undefined and empty string as the empty marker', () => {
    expect(normalizeDateTime(null)).toBe('')
    expect(normalizeDateTime(undefined)).toBe('')
    expect(normalizeDateTime('')).toBe('')
  })
})

describe('buildProfileBody', () => {
  it('builds a create/PATCH body carrying the @odata.type subtype and set fields', () => {
    const specs = extractProfileSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            profile_name: 'Pilot',
            description: 'd',
            featureUpdateVersion: 'Windows 11, version 23H2',
            installLatestWindows10OnWindows11IneligibleDevice: true,
          },
        },
      ]).canvas,
    )
    const body = buildProfileBody(specs[0]) as Record<string, unknown>
    expect(body['@odata.type']).toBe(WINDOWS_FEATURE_UPDATE_PROFILE_ODATA_TYPE)
    expect(body.displayName).toBe('Pilot')
    expect(body.description).toBe('d')
    expect(body.roleScopeTagIds).toEqual(['0'])
    expect(body.featureUpdateVersion).toBe('Windows 11, version 23H2')
    expect(body.installLatestWindows10OnWindows11IneligibleDevice).toBe(true)
    // No rollout declared → rolloutSettings is omitted (update available immediately).
    expect(body.rolloutSettings).toBeUndefined()
  })

  it('includes rolloutSettings when a rollout window is declared', () => {
    const specs = extractProfileSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            profile_name: 'Gradual',
            featureUpdateVersion: 'Windows 11, version 23H2',
            rolloutStartDate: '2026-09-01T00:00:00Z',
            rolloutEndDate: '2026-09-30T00:00:00Z',
            rolloutIntervalInDays: 7,
          },
        },
      ]).canvas,
    )
    const body = buildProfileBody(specs[0]) as Record<string, unknown>
    const rollout = body.rolloutSettings as Record<string, unknown>
    expect(rollout).toBeDefined()
    expect(rollout.offerStartDateTimeInUTC).toBe('2026-09-01T00:00:00Z')
    expect(rollout.offerEndDateTimeInUTC).toBe('2026-09-30T00:00:00Z')
    expect(rollout.offerIntervalInDays).toBe(7)
  })
})

describe('deploy helpers', () => {
  it('captureManagedFields keeps managed fields and drops read-only server state', () => {
    const captured = captureManagedFields({
      '@odata.type': WINDOWS_FEATURE_UPDATE_PROFILE_ODATA_TYPE,
      id: 'abc',
      displayName: 'Pilot',
      featureUpdateVersion: 'Windows 11, version 23H2',
      installLatestWindows10OnWindows11IneligibleDevice: true,
      createdDateTime: '2026-01-01T00:00:00Z',
      lastModifiedDateTime: '2026-01-02T00:00:00Z',
      deployableContentDisplayName: 'Windows 11, version 23H2',
      endOfSupportDate: '2026-12-31T00:00:00Z',
    })
    expect(captured.featureUpdateVersion).toBe('Windows 11, version 23H2')
    expect(captured.installLatestWindows10OnWindows11IneligibleDevice).toBe(true)
    expect(captured.createdDateTime).toBeUndefined()
    expect(captured.lastModifiedDateTime).toBeUndefined()
    expect(captured.deployableContentDisplayName).toBeUndefined()
    expect(captured.endOfSupportDate).toBeUndefined()
  })
})
