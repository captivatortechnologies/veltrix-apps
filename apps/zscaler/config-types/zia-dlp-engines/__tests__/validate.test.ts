import validate, { extractDlpEngineSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-dlp-engines',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-dlp-engines',
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

describe('ZIA DLP Engines Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid DLP engine', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'DLP Engine',
          fields: { name: 'Credit Cards', description: 'PCI', engine_expression: '((D63.S > 1))' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { engine_expression: '((D63.S > 1))' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing engine expression', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Expr' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('engine_expression'))).toBe(
      true,
    )
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256), engine_expression: '((D1.S > 0))' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'PII', engine_expression: '((D1.S > 0))' } },
        { name: 'b', fields: { name: 'pii', engine_expression: '((D2.S > 0))' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_dlp_engine')).toBe(true)
  })

  it('extractDlpEngineSpecs trims fields, drops blank description, and defaults custom_dlp_engine true', () => {
    const specs = extractDlpEngineSpecs(
      makeCtx([
        {
          name: 'DLP Engine',
          fields: { name: '  SSN  ', description: '   ', engine_expression: '  ((D9.S > 0))  ' },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('SSN')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].engineExpression).toBe('((D9.S > 0))')
    expect(specs[0].customDlpEngine).toBe(true)
  })
})
