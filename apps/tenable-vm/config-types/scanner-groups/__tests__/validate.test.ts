import validate, { extractScannerGroupSpecs, MAX_SCANNER_GROUP_NAME_LENGTH } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'scanner-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'scanner-groups',
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

describe('Tenable Scanner Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid scanner group', async () => {
    const result = await validate(
      makeCtx([{ name: 'Scanner Group', fields: { name: 'US-East Load Balancers' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a blank (whitespace-only) name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '   ' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than the maximum length', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(MAX_SCANNER_GROUP_NAME_LENGTH + 1) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate scanner group names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Primary Pool' } },
        { name: 'sec2', fields: { name: 'primary pool' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows two distinct scanner group names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'US-East Pool' } },
        { name: 'sec2', fields: { name: 'EU-West Pool' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractScannerGroupSpecs', () => {
  it('trims the name field', () => {
    const sections = [{ name: 'sec1', fields: { name: '  Primary Pool  ' } }]
    const specs = extractScannerGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'scanner-groups',
      items: sections,
      sections,
      snapshot: {},
    })
    expect(specs[0].name).toBe('Primary Pool')
  })

  it('yields an empty name when the field is absent', () => {
    const sections = [{ name: 'sec1', fields: {} }]
    const specs = extractScannerGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'scanner-groups',
      items: sections,
      sections,
      snapshot: {},
    })
    expect(specs[0].name).toBe('')
  })
})
