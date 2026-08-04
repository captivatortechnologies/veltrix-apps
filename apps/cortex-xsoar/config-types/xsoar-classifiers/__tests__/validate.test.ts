import validate, { extractClassifierSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cortex-xsoar',
    customerId: 'cust-1',
    configTypeId: 'xsoar-classifiers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cortex-xsoar',
      entityType: 'xsoar-classifiers',
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

describe('Cortex XSOAR Classifiers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid classifier', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { id: 'Acme', name: 'Acme Alerts - Classification' } }]),
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
        { name: 'a', fields: { id: 'Acme', name: 'A' } },
        { name: 'b', fields: { id: 'Acme', name: 'B' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_classifier')).toBe(true)
  })

  it('rejects malformed classification-rules JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { id: 'Acme', name: 'Acme', classifierConfig: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config_json')).toBe(true)
  })

  it('rejects classification-rules JSON that is not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { id: 'Acme', name: 'Acme', classifierConfig: '[1,2]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config_json')).toBe(true)
  })

  it('warns on an empty classification-rules blob', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: { id: 'Acme', name: 'Acme' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'empty_config')).toBe(true)
  })

  it('accepts valid classification-rules JSON', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 's1',
          fields: { id: 'Acme', name: 'Acme', classifierConfig: '{"keyTypeMap": {"alert": "Acme Alert"}}' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'empty_config')).toBe(false)
  })

  it('extractClassifierSpecs defaults feed to false', () => {
    const specs = extractClassifierSpecs(makeCtx([{ name: 's', fields: { id: 'Acme', name: 'Acme' } }]).canvas)
    expect(specs[0].feed).toBe(false)
  })
})
