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
    entityType: 'internet-firewall-sections',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cato-networks',
    customerId: 'cust-1',
    configTypeId: 'internet-firewall-sections',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Internet Firewall Sections validate', () => {
  it('accepts an empty canvas (sections are optional)', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(true)
  })

  it('validates a minimal section', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Corporate Traffic' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('rejects a name over 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'x'.repeat(256) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MAX_LENGTH')).toBe(true)
  })

  it('rejects a duplicate section name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'i1', fields: { name: 'Guest' } },
        { name: 'i2', fields: { name: 'guest' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('requires positionSectionName when position is BEFORE_SECTION', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Guest', position: 'BEFORE_SECTION' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MISSING_POSITION_REF')).toBe(true)
  })

  it('accepts BEFORE_SECTION with a positionSectionName set', async () => {
    const result = await validate(
      makeCtx([{ name: 'i1', fields: { name: 'Guest', position: 'BEFORE_SECTION', positionSectionName: 'Corporate' } }]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractSectionSpecs', () => {
  it('defaults position to LAST_IN_POLICY and falls back on an invalid value', () => {
    const specs = extractSectionSpecs(makeCanvas([{ name: 'i1', fields: { name: 'Guest', position: 'NOT_A_POSITION' } }]))
    expect(specs[0].position).toBe('LAST_IN_POLICY')
  })

  it('trims name and positionSectionName', () => {
    const specs = extractSectionSpecs(
      makeCanvas([{ name: 'i1', fields: { name: '  Guest  ', position: 'AFTER_SECTION', positionSectionName: '  Corporate  ' } }]),
    )
    expect(specs[0].name).toBe('Guest')
    expect(specs[0].positionSectionName).toBe('Corporate')
  })
})
