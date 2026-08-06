import validate, { extractAllowedAccessSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'akeyless',
    customerId: 'cust-1',
    configTypeId: 'gateway-allowed-access',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'akeyless',
      entityType: 'gateway-allowed-access',
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

describe('Akeyless Gateway Allowed Access Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal rule', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { name: 'ci-access', accessId: 'p-abc123' } }]))
    expect(result.valid).toBe(true)
  })

  it('requires accessId', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { name: 'ci-access' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.accessId'))).toBe(true)
  })

  it('rejects an invalid permission', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { name: 'ci-access', accessId: 'p-1', permissions: ['fly'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.permissions'))).toBe(true)
  })

  it('accepts a valid permission list', async () => {
    const result = await validate(
      makeCtx([{ name: 'a1', fields: { name: 'ci-access', accessId: 'p-1', permissions: ['targets', 'dynamic_secret'] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a1', fields: { name: 'dup', accessId: 'p-1' } },
        { name: 'a2', fields: { name: 'dup', accessId: 'p-1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractAllowedAccessSpecs', () => {
  it('defaults caseSensitive to true', () => {
    const specs = extractAllowedAccessSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'gateway-allowed-access',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'x', accessId: 'p-1' } }],
      snapshot: {},
    })
    expect(specs[0].caseSensitive).toBe(true)
  })

  it('respects an explicit caseSensitive=false', () => {
    const specs = extractAllowedAccessSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'gateway-allowed-access',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'x', accessId: 'p-1', caseSensitive: false } }],
      snapshot: {},
    })
    expect(specs[0].caseSensitive).toBe(false)
  })
})
