import validate, { extractHostGroupSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'host-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'host-groups',
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('CrowdStrike Host Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid dynamic group', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Group',
          fields: {
            name: 'Production Windows Servers',
            groupType: 'dynamic',
            assignmentRule: "platform_name:'Windows'+tags:'SensorGroupingTags/production'",
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid static group without an assignment rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'Group', fields: { name: 'Manual Group', groupType: 'static' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects missing group name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { groupType: 'static' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects unknown group types (case-sensitive)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'g1', groupType: 'StaticByID' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_group_type')).toBe(true)
  })

  it('accepts staticByID with exact casing', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'g1', groupType: 'staticByID' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires an assignment rule for dynamic groups', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'g1', groupType: 'dynamic' } }]),
    )
    expect(result.valid).toBe(false)
    expect(
      result.errors.some((e) => e.code === 'required' && e.field.includes('assignmentRule')),
    ).toBe(true)
  })

  it('rejects assignment rules on static groups', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'g1', groupType: 'static', assignmentRule: "hostname:'PROD*'" },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'assignment_rule_conflict')).toBe(true)
  })

  it('rejects assignment rules with unbalanced quotes', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'g1', groupType: 'dynamic', assignmentRule: "platform_name:'Windows" },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_fql')).toBe(true)
  })

  it('rejects duplicate group names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Servers', groupType: 'static' } },
        { name: 'sec2', fields: { name: 'servers', groupType: 'static' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractHostGroupSpecs', () => {
  it('trims fields and drops empty optional values', () => {
    const specs = extractHostGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'host-groups',
      sections: [
        {
          name: 'sec1',
          fields: { name: '  g1  ', groupType: 'static', description: '  ', assignmentRule: '' },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('g1')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].assignmentRule).toBeUndefined()
  })
})
