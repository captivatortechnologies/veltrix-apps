import validate, { extractGroupSpecs, groupKey, liveMemberNames } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'checkpoint',
    customerId: 'cust-1',
    configTypeId: 'network-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'checkpoint',
      entityType: 'network-groups',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Check Point Network Groups Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a group with members', async () => {
    const result = await validate(makeCtx([{ name: 'Grp', fields: { name: 'web-servers', members: ['web-01', 'web-02'] } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('allows an empty-member group', async () => {
    const result = await validate(makeCtx([{ name: 'Grp', fields: { name: 'empty-group' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: '', fields: { members: ['a'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate group names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Web-Servers' } },
        { name: 'b', fields: { name: 'web-servers' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('extractGroupSpecs trims fields and reads member lists', () => {
    const specs = extractGroupSpecs(
      makeCtx([{ id: 'i1', name: 'e', fields: { name: '  grp-2  ', members: ['a', ' b '] } }]).canvas,
    )
    expect(specs[0].name).toBe('grp-2')
    expect(specs[0].members).toEqual(['a', 'b'])
    expect(groupKey('  Grp-2 ')).toBe('grp-2')
  })
})

describe('liveMemberNames', () => {
  it('flattens string and object-summary members', () => {
    expect(liveMemberNames(['web-01', { name: 'web-02' }])).toEqual(['web-01', 'web-02'])
  })

  it('tolerates a missing members array', () => {
    expect(liveMemberNames(undefined)).toEqual([])
  })
})
