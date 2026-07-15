import validate, { extractExclusionSpecs, exclusionKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId: 's1-exclusions',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sentinelone',
      entityType: 's1-exclusions',
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

describe('SentinelOne Exclusions Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid path exclusion', async () => {
    const result = await validate(
      makeCtx([{ name: 'Exclusion', fields: { type: 'path', value: 'C:\\Temp\\', os_type: 'windows' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing value + os', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'path' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('value'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('os_type'))).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'nope', value: 'x', os_type: 'windows' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an invalid path mode', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'path', value: 'C:\\x\\', os_type: 'windows', mode: 'nope' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_mode')).toBe(true)
  })

  it('rejects duplicate (type,value,os)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { type: 'white_hash', value: 'abc', os_type: 'windows' } },
        { name: 'b', fields: { type: 'white_hash', value: 'abc', os_type: 'windows' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_exclusion')).toBe(true)
  })

  it('extractExclusionSpecs defaults mode/pathExclusionType and trims', () => {
    const specs = extractExclusionSpecs(makeCtx([{ name: 'e', fields: { type: 'path', value: '  C:\\x\\  ', os_type: 'windows' } }]).canvas)
    expect(specs[0].value).toBe('C:\\x\\')
    expect(specs[0].mode).toBe('disable_all_monitors')
    expect(specs[0].pathExclusionType).toBe('folder')
    expect(exclusionKey(specs[0])).toBe(exclusionKey({ type: 'path', value: 'C:\\x\\', osType: 'windows' }))
  })
})
