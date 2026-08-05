import validate, { extractRoleSpecs, toList } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'onelogin',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'onelogin',
      entityType: 'roles',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('OneLogin Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid role with no apps assigned', async () => {
    const result = await validate(makeCtx([{ name: 'Role', fields: { name: 'Sales Team' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid role with apps assigned', async () => {
    const result = await validate(makeCtx([{ name: 'Role', fields: { name: 'Sales Team', appIds: ['1', '2', '3'] } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate role name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Sales Team' } },
        { name: 'sec2', fields: { name: 'Sales Team' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_role')).toBe(true)
  })

  it('allows two distinct role names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Sales Team' } },
        { name: 'sec2', fields: { name: 'Engineering' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a non-numeric appId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Sales Team', appIds: ['abc'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_app_id')).toBe(true)
  })

  it('rejects a zero/negative appId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Sales Team', appIds: ['0', '-5'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_app_id')).toBe(true)
  })
})

describe('extractRoleSpecs', () => {
  it('parses appIds into numbers and drops invalid entries', () => {
    const specs = extractRoleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onelogin',
      entityType: 'roles',
      items: [],
      sections: [{ name: 'sec1', fields: { name: '  Sales Team  ', appIds: ['1', '2', 'abc', '3'] } }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Sales Team')
    expect(specs[0].appIds).toEqual([1, 2, 3])
  })

  it('defaults appIds to an empty array when absent', () => {
    const specs = extractRoleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onelogin',
      entityType: 'roles',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'Sales Team' } }],
      snapshot: {},
    })
    expect(specs[0].appIds).toEqual([])
  })
})

describe('toList', () => {
  it('trims and filters array entries', () => {
    expect(toList([' a ', '', 'b'])).toEqual(['a', 'b'])
  })
  it('splits comma/newline separated strings', () => {
    expect(toList('a, b\nc')).toEqual(['a', 'b', 'c'])
  })
  it('returns an empty array for undefined/null', () => {
    expect(toList(undefined)).toEqual([])
    expect(toList(null)).toEqual([])
  })
})
