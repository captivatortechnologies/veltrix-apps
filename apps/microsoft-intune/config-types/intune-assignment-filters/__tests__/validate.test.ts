import validate, { extractFilterSpecs, filterKey, canonicalPlatform } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import { buildFilterBody, buildFilterUpdateBody } from '../deploy'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-assignment-filters',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-assignment-filters',
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

const VALID_FIELDS = {
  filter_name: 'Corp Windows',
  platform: 'windows10AndLater',
  management_type: 'devices',
  rule: '(device.osVersion -startsWith "10.0")',
}

describe('Intune Assignment Filters Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a well-formed filter', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: VALID_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('requires a filter name', async () => {
    const result = await validate(
      makeCtx([{ name: 'f', fields: { platform: 'windows10AndLater', management_type: 'devices', rule: '(device.osVersion -eq "1")' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.filter_name') && e.code === 'required')).toBe(true)
  })

  it('requires a rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'f', fields: { filter_name: 'Corp Windows', platform: 'windows10AndLater', management_type: 'devices' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.rule') && e.code === 'required')).toBe(true)
  })

  it('rejects an unknown platform', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: { ...VALID_FIELDS, platform: 'blackberry' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_platform')).toBe(true)
  })

  it('rejects an unknown management type', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: { ...VALID_FIELDS, management_type: 'users' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_management_type')).toBe(true)
  })

  it('rejects duplicate filter names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...VALID_FIELDS, filter_name: 'Corp Windows' } },
        { name: 'b', fields: { ...VALID_FIELDS, filter_name: 'CORP WINDOWS' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_filter')).toBe(true)
  })

  it('extract reads fields, trims the name and defaults the management type', () => {
    const specs = extractFilterSpecs(
      makeCtx([
        {
          name: 'f',
          fields: {
            filter_name: '  Corp Windows  ',
            platform: 'iOS',
            rule: '(device.model -eq "iPhone")',
            role_scope_tags: ['0', '5'],
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Corp Windows')
    expect(specs[0].platform).toBe('iOS')
    expect(specs[0].managementType).toBe('devices')
    expect(specs[0].roleScopeTags).toEqual(['0', '5'])
    expect(filterKey('  Corp Windows ')).toBe('corp windows')
  })

  it('canonicalPlatform resolves casing and rejects unknowns', () => {
    expect(canonicalPlatform('ios')).toBe('iOS')
    expect(canonicalPlatform('WINDOWS10ANDLATER')).toBe('windows10AndLater')
    expect(canonicalPlatform('nope')).toBe('')
  })

  it('builds a create body with canonical platform and a default role scope tag', () => {
    const specs = extractFilterSpecs(makeCtx([{ name: 'f', fields: VALID_FIELDS }]).canvas)
    const body = buildFilterBody(specs[0]) as {
      displayName: string
      platform: string
      rule: string
      assignmentFilterManagementType: string
      roleScopeTags: string[]
    }
    expect(body.displayName).toBe('Corp Windows')
    expect(body.platform).toBe('windows10AndLater')
    expect(body.rule).toBe('(device.osVersion -startsWith "10.0")')
    expect(body.assignmentFilterManagementType).toBe('devices')
    expect(body.roleScopeTags).toEqual(['0'])
  })

  it('omits the immutable platform from the update body', () => {
    const specs = extractFilterSpecs(makeCtx([{ name: 'f', fields: VALID_FIELDS }]).canvas)
    const body = buildFilterUpdateBody(specs[0]) as Record<string, unknown>
    expect(body.platform).toBeUndefined()
    expect(body.displayName).toBe('Corp Windows')
    expect(body.rule).toBe('(device.osVersion -startsWith "10.0")')
  })
})
