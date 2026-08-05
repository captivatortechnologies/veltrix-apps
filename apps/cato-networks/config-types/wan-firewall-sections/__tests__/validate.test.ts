import validate, { extractSectionSpecs } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCanvas(items: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'cato-networks',
    entityType: 'wan-firewall-sections',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cato-networks',
    customerId: 'cust-1',
    configTypeId: 'wan-firewall-sections',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('WAN Firewall Sections validate', () => {
  it('accepts an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(true)
  })

  it('validates a minimal section', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Datacenter Access' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('rejects a duplicate section name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'i1', fields: { name: 'DC' } },
        { name: 'i2', fields: { name: 'dc' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('requires positionSectionName for AFTER_SECTION', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'DC', position: 'AFTER_SECTION' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MISSING_POSITION_REF')).toBe(true)
  })
})

describe('extractSectionSpecs', () => {
  it('defaults position to LAST_IN_POLICY', () => {
    const specs = extractSectionSpecs(makeCanvas([{ name: 'i1', fields: { name: 'DC' } }]))
    expect(specs[0].position).toBe('LAST_IN_POLICY')
  })
})
