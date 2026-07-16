import validate, { extractPoolSpecs, parseEngineNames, poolKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-scan-engine-pools',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-scan-engine-pools',
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

describe('InsightVM Scan Engine Pools Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a pool with member engines', async () => {
    const result = await validate(
      makeCtx([{ name: 'Pool', fields: { name: 'East DC Pool', engines: 'engine-a\nengine-b' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a pool with no engines (engines are optional)', async () => {
    const result = await validate(makeCtx([{ name: 'Pool', fields: { name: 'Empty Pool' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { engines: 'engine-a' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate pool names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Prod Pool' } },
        { name: 'b', fields: { name: 'prod pool' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_pool')).toBe(true)
  })

  it('parseEngineNames splits lines, trims and drops blanks', () => {
    expect(parseEngineNames('  engine-a \n\n  engine-b\r\n')).toEqual(['engine-a', 'engine-b'])
    expect(parseEngineNames('   ')).toEqual([])
    expect(parseEngineNames(undefined)).toEqual([])
  })

  it('extract + key helpers behave', () => {
    const specs = extractPoolSpecs(
      makeCtx([{ name: 'p', fields: { name: '  West Pool  ', engines: 'e1\ne2\ne3' } }]).canvas,
    )
    expect(specs[0].name).toBe('West Pool')
    expect(specs[0].engines).toEqual(['e1', 'e2', 'e3'])
    expect(poolKey(specs[0])).toBe(poolKey({ name: 'WEST POOL' }))
  })
})
