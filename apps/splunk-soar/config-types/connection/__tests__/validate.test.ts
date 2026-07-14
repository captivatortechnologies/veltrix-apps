import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-soar',
    customerId: 'cust-1',
    configTypeId: 'connection',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-soar',
      entityType: 'connection',
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

describe('Splunk SOAR Connection Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid connection profile', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'prod-soar', description: 'Production SOAR' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a connection profile without a description', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'prod-soar' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing connection name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a blank connection name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '   ' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a connection name exceeding max length', async () => {
    const longName = 'a'.repeat(121)
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: longName } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('detects duplicate connection names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'dup-soar' } },
        { name: 'sec2', fields: { name: 'dup-soar' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('validates multiple distinct sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'soar-one' } },
        { name: 'sec2', fields: { name: 'soar-two' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})
