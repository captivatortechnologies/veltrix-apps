import validate, { extractTagSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'tags',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'tags',
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

describe('Elastic Security Tags Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal tag', async () => {
    const result = await validate(
      makeCtx([{ name: 'Tag', fields: { id: 'team-secops', name: 'Team: SecOps', color: '#0B64DD' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing id', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { name: 'X', color: '#000000' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('id'))).toBe(true)
  })

  it('rejects an invalid id', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { id: 'Team SecOps', name: 'X', color: '#000' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_id')).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { id: 'ops', color: '#000' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing/invalid color', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { id: 'ops', name: 'Ops', color: 'blue' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_color')).toBe(true)
  })

  it('rejects a duplicate tag id (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 't1', fields: { id: 'ops', name: 'Ops', color: '#000' } },
        { name: 't2', fields: { id: 'OPS', name: 'Ops2', color: '#000' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_tag')).toBe(true)
  })
})

describe('extractTagSpecs', () => {
  it('trims fields', () => {
    const specs = extractTagSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'tags',
      items: [],
      sections: [{ name: 'sec1', fields: { id: '  ops  ', name: '  Ops  ', color: ' #0B64DD ', description: '  ' } }],
      snapshot: {},
    })
    expect(specs[0].id).toBe('ops')
    expect(specs[0].name).toBe('Ops')
    expect(specs[0].color).toBe('#0B64DD')
    expect(specs[0].description).toBeUndefined()
  })
})
