import validate, {
  buildRingBody,
  extractRingSpecs,
  hasAnyAssignment,
  ringKey,
  WINDOWS_UPDATE_RING_ODATA_TYPE,
} from '../validate'
import { captureManagedFields, isUpdateRing } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-windows-update-rings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-windows-update-rings',
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

describe('Intune Windows Update Rings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a ring with a name, in-range fields and an assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: {
            ring_name: 'Pilot',
            qualityUpdatesDeferralPeriodInDays: 7,
            featureUpdatesDeferralPeriodInDays: 365,
            automaticUpdateMode: 'autoInstallAtMaintenanceTime',
            includeGroups: ['11111111-1111-1111-1111-111111111111'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('requires a ring name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { qualityUpdatesDeferralPeriodInDays: 7, allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate ring names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ring_name: 'Broad', allDevices: true } },
        { name: 'b', fields: { ring_name: 'BROAD', allDevices: true } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_ring')).toBe(true)
  })

  it('rejects deferral periods out of range', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: {
            ring_name: 'Bad',
            qualityUpdatesDeferralPeriodInDays: 40,
            featureUpdatesDeferralPeriodInDays: 400,
            allDevices: true,
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'out_of_range')).toHaveLength(2)
  })

  it('rejects an unknown enum value', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { ring_name: 'Bad', automaticUpdateMode: 'bogus', allDevices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('warns when a ring targets nothing', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { ring_name: 'Orphan', qualityUpdatesDeferralPeriodInDays: 3 } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_assignment')).toBe(true)
  })
})

describe('extractRingSpecs', () => {
  it('reads name/description, managed fields and assignments; omits blank fields', () => {
    const specs = extractRingSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            ring_name: '  Pilot  ',
            description: '  broad pilot  ',
            qualityUpdatesDeferralPeriodInDays: 7,
            allowWindows11Upgrade: true,
            deliveryOptimizationMode: 'httpOnly',
            includeGroups: 'g1, g2',
            excludeGroups: ['g3'],
            allDevices: false,
            allUsers: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Pilot')
    expect(specs[0].description).toBe('broad pilot')
    expect(specs[0].graph.qualityUpdatesDeferralPeriodInDays).toBe(7)
    expect(specs[0].graph.allowWindows11Upgrade).toBe(true)
    expect(specs[0].graph.deliveryOptimizationMode).toBe('httpOnly')
    // A field the user did not set is omitted (left unmanaged).
    expect(specs[0].graph.featureUpdatesDeferralPeriodInDays).toBeUndefined()
    expect(specs[0].assignments.includeGroupIds).toEqual(['g1', 'g2'])
    expect(specs[0].assignments.excludeGroupIds).toEqual(['g3'])
    expect(specs[0].assignments.allUsers).toBe(true)
    expect(specs[0].assignments.allDevices).toBe(false)
  })

  it('ringKey trims and lowercases', () => {
    expect(ringKey('  Pilot Ring ')).toBe('pilot ring')
  })

  it('hasAnyAssignment reflects declared targets', () => {
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(false)
    expect(hasAnyAssignment({ includeGroupIds: ['g1'], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(true)
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: true, allUsers: false })).toBe(true)
  })
})

describe('buildRingBody', () => {
  it('builds a create/PATCH body carrying the @odata.type subtype and set fields', () => {
    const specs = extractRingSpecs(
      makeCtx([{ name: 'p', fields: { ring_name: 'Pilot', description: 'd', qualityUpdatesDeferralPeriodInDays: 7, allowWindows11Upgrade: true } }]).canvas,
    )
    const body = buildRingBody(specs[0]) as Record<string, unknown>
    expect(body['@odata.type']).toBe(WINDOWS_UPDATE_RING_ODATA_TYPE)
    expect(body.displayName).toBe('Pilot')
    expect(body.description).toBe('d')
    expect(body.roleScopeTagIds).toEqual(['0'])
    expect(body.qualityUpdatesDeferralPeriodInDays).toBe(7)
    expect(body.allowWindows11Upgrade).toBe(true)
    // Unset fields are not sent.
    expect(body.featureUpdatesDeferralPeriodInDays).toBeUndefined()
  })
})

describe('deploy helpers', () => {
  it('isUpdateRing matches only the windowsUpdateForBusinessConfiguration @odata.type', () => {
    expect(isUpdateRing({ '@odata.type': '#microsoft.graph.windowsUpdateForBusinessConfiguration' })).toBe(true)
    expect(isUpdateRing({ '@odata.type': '#microsoft.graph.iosUpdateConfiguration' })).toBe(false)
    expect(isUpdateRing({})).toBe(false)
  })

  it('captureManagedFields keeps managed fields and drops server-managed state', () => {
    const captured = captureManagedFields({
      '@odata.type': WINDOWS_UPDATE_RING_ODATA_TYPE,
      id: 'abc',
      displayName: 'Pilot',
      qualityUpdatesDeferralPeriodInDays: 5,
      automaticUpdateMode: 'notifyDownload',
      version: 3,
      lastModifiedDateTime: '2026-01-01T00:00:00Z',
      qualityUpdatesPauseStartDate: '2026-01-01',
    })
    expect(captured.qualityUpdatesDeferralPeriodInDays).toBe(5)
    expect(captured.automaticUpdateMode).toBe('notifyDownload')
    expect(captured.version).toBeUndefined()
    expect(captured.lastModifiedDateTime).toBeUndefined()
    expect(captured.qualityUpdatesPauseStartDate).toBeUndefined()
  })
})
