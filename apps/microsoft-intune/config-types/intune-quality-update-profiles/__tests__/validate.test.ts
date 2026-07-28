import validate, {
  buildExpeditedSettings,
  buildProfileBody,
  extractProfileSpecs,
  hasAnyAssignment,
  profileKey,
  EXPEDITED_SETTINGS_ODATA_TYPE,
  QUALITY_UPDATE_PROFILE_ODATA_TYPE,
} from '../validate'
import { captureExpeditedSettings } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-quality-update-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-quality-update-profiles',
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

describe('Intune Quality Update Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a profile with a name, a release, in-range reboot grace and an assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: {
            profile_name: 'Expedite March',
            qualityUpdateRelease: '2026-03 B',
            daysUntilForcedReboot: 2,
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
    const result = await validate(makeCtx([{ name: 'p', fields: { qualityUpdateRelease: '2026-03 B', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a quality update release', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { profile_name: 'No Release', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate profile names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { profile_name: 'March', qualityUpdateRelease: 'r1', allDevices: true } },
        { name: 'b', fields: { profile_name: 'MARCH', qualityUpdateRelease: 'r2', allDevices: true } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_profile')).toBe(true)
  })

  it('rejects a reboot grace out of the 0-2 range', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { profile_name: 'Bad', qualityUpdateRelease: 'r', daysUntilForcedReboot: 5, allDevices: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'out_of_range')).toHaveLength(1)
  })

  it('rejects a non-integer reboot grace', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { profile_name: 'Bad', qualityUpdateRelease: 'r', daysUntilForcedReboot: 1.5, allDevices: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })

  it('warns when a profile targets nothing', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { profile_name: 'Orphan', qualityUpdateRelease: 'r' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_assignment')).toBe(true)
  })
})

describe('extractProfileSpecs', () => {
  it('reads name/description/release, reboot grace and assignments; omits blank reboot grace', () => {
    const specs = extractProfileSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            profile_name: '  Expedite March  ',
            description: '  rush the March update  ',
            qualityUpdateRelease: '  2026-03 B  ',
            includeGroups: 'g1, g2',
            excludeGroups: ['g3'],
            allDevices: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Expedite March')
    expect(specs[0].description).toBe('rush the March update')
    expect(specs[0].qualityUpdateRelease).toBe('2026-03 B')
    // A blank reboot grace is omitted (left unmanaged → Intune default).
    expect(specs[0].daysUntilForcedReboot).toBeUndefined()
    expect(specs[0].assignments.includeGroupIds).toEqual(['g1', 'g2'])
    expect(specs[0].assignments.excludeGroupIds).toEqual(['g3'])
    expect(specs[0].assignments.allDevices).toBe(true)
  })

  it('reads a numeric reboot grace', () => {
    const specs = extractProfileSpecs(
      makeCtx([{ name: 'p', fields: { profile_name: 'M', qualityUpdateRelease: 'r', daysUntilForcedReboot: 0 } }]).canvas,
    )
    expect(specs[0].daysUntilForcedReboot).toBe(0)
  })

  it('profileKey trims and lowercases', () => {
    expect(profileKey('  Expedite March ')).toBe('expedite march')
  })

  it('hasAnyAssignment reflects declared targets', () => {
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(false)
    expect(hasAnyAssignment({ includeGroupIds: ['g1'], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(true)
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: true, allUsers: false })).toBe(true)
  })
})

describe('buildProfileBody / buildExpeditedSettings', () => {
  it('builds a create/PATCH body carrying both @odata.types and the release', () => {
    const specs = extractProfileSpecs(
      makeCtx([{ name: 'p', fields: { profile_name: 'March', description: 'd', qualityUpdateRelease: '2026-03 B', daysUntilForcedReboot: 1 } }]).canvas,
    )
    const body = buildProfileBody(specs[0]) as Record<string, unknown>
    expect(body['@odata.type']).toBe(QUALITY_UPDATE_PROFILE_ODATA_TYPE)
    expect(body.displayName).toBe('March')
    expect(body.description).toBe('d')
    expect(body.roleScopeTagIds).toEqual(['0'])
    const settings = body.expeditedUpdateSettings as Record<string, unknown>
    expect(settings['@odata.type']).toBe(EXPEDITED_SETTINGS_ODATA_TYPE)
    expect(settings.qualityUpdateRelease).toBe('2026-03 B')
    expect(settings.daysUntilForcedReboot).toBe(1)
  })

  it('omits daysUntilForcedReboot from the settings when it is unset', () => {
    const specs = extractProfileSpecs(
      makeCtx([{ name: 'p', fields: { profile_name: 'March', qualityUpdateRelease: 'r' } }]).canvas,
    )
    const settings = buildExpeditedSettings(specs[0])
    expect(settings.qualityUpdateRelease).toBe('r')
    expect(settings.daysUntilForcedReboot).toBeUndefined()
  })
})

describe('deploy helpers', () => {
  it('captureExpeditedSettings keeps release/days and drops anything else', () => {
    const captured = captureExpeditedSettings({
      expeditedUpdateSettings: {
        '@odata.type': EXPEDITED_SETTINGS_ODATA_TYPE,
        qualityUpdateRelease: '2026-02 B',
        daysUntilForcedReboot: 2,
      },
    })
    expect(captured).toBeDefined()
    expect((captured as Record<string, unknown>).qualityUpdateRelease).toBe('2026-02 B')
    expect((captured as Record<string, unknown>).daysUntilForcedReboot).toBe(2)
    // The nested @odata.type is not captured — rollback re-adds it.
    expect((captured as Record<string, unknown>)['@odata.type']).toBeUndefined()
  })

  it('captureExpeditedSettings returns undefined when there are no settings', () => {
    expect(captureExpeditedSettings({})).toBeUndefined()
    expect(captureExpeditedSettings(null)).toBeUndefined()
  })
})
