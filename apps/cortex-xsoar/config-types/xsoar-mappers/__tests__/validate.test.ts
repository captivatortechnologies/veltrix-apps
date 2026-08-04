import validate, { extractMapperSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cortex-xsoar',
    customerId: 'cust-1',
    configTypeId: 'xsoar-mappers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cortex-xsoar',
      entityType: 'xsoar-mappers',
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

describe('Cortex XSOAR Mappers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid incoming mapper', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { id: 'AcmeIn', name: 'Acme Incoming', direction: 'incoming' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing id', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: { name: 'No ID' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('id'))).toBe(true)
  })

  it('rejects a duplicate id', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { id: 'AcmeIn', name: 'A', direction: 'incoming' } },
        { name: 'b', fields: { id: 'AcmeIn', name: 'B', direction: 'outgoing' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_mapper')).toBe(true)
  })

  it('rejects malformed field-mapping JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { id: 'AcmeIn', name: 'Acme', mapperConfig: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config_json')).toBe(true)
  })

  it('warns on an empty field-mapping blob', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: { id: 'AcmeIn', name: 'Acme' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'empty_config')).toBe(true)
  })

  it('extractMapperSpecs defaults an unrecognized direction to incoming', () => {
    const specs = extractMapperSpecs(
      makeCtx([{ name: 's', fields: { id: 'AcmeIn', name: 'Acme', direction: 'sideways' } }]).canvas,
    )
    expect(specs[0].direction).toBe('incoming')
  })

  it('extractMapperSpecs reads an explicit outgoing direction', () => {
    const specs = extractMapperSpecs(
      makeCtx([{ name: 's', fields: { id: 'AcmeOut', name: 'Acme', direction: 'outgoing' } }]).canvas,
    )
    expect(specs[0].direction).toBe('outgoing')
  })
})
