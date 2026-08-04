import validate, { extractServiceGroupSpecs, liveMemberNames, serviceGroupKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'checkpoint',
    customerId: 'cust-1',
    configTypeId: 'service-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'checkpoint',
      entityType: 'service-groups',
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

describe('Check Point Service Groups Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a group with members', async () => {
    const result = await validate(makeCtx([{ name: 'Grp', fields: { name: 'web-services', members: ['http', 'https'] } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('allows an empty-member group', async () => {
    const result = await validate(makeCtx([{ name: 'Grp', fields: { name: 'empty-group' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: '', fields: { members: ['http'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate service group names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Web-Services' } },
        { name: 'b', fields: { name: 'web-services' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('extractServiceGroupSpecs trims fields and reads member lists', () => {
    const specs = extractServiceGroupSpecs(
      makeCtx([{ id: 'i1', name: 'e', fields: { name: '  svc-grp-2  ', members: ['http', ' https '] } }]).canvas,
    )
    expect(specs[0].name).toBe('svc-grp-2')
    expect(specs[0].members).toEqual(['http', 'https'])
    expect(serviceGroupKey('  Svc-Grp-2 ')).toBe('svc-grp-2')
  })
})

describe('liveMemberNames', () => {
  it('flattens string and object-summary members', () => {
    expect(liveMemberNames(['http', { name: 'https' }])).toEqual(['http', 'https'])
  })

  it('tolerates a missing members array', () => {
    expect(liveMemberNames(undefined)).toEqual([])
  })
})
