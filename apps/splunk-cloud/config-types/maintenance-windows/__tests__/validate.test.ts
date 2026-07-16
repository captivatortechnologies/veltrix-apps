import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'maintenance-windows',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
      entityType: 'maintenance-windows',
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

/** A valid, future-dated, Splunk-only freeze that raises no warnings. */
function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startDate: '2030/01/01',
    endDate: '2030/01/05',
    appliesTo: 'Splunk Initiated Changes Only',
    reason: 'End-of-quarter change freeze',
    ...overrides,
  }
}

describe('Splunk Cloud Maintenance Window Change Freeze Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid change freeze with no warnings', async () => {
    const result = await validate(makeCtx([{ name: 'freeze', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('accepts optional tickets as a comma-separated string', async () => {
    const result = await validate(
      makeCtx([{ name: 'freeze', fields: validFields({ tickets: 'CHG-1, CHG-2' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects more than one change freeze', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: validFields() },
        { name: 'b', fields: validFields({ startDate: '2030/02/01', endDate: '2030/02/05' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'single_item')).toBe(true)
  })

  it('rejects a missing start date', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: validFields({ startDate: undefined }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a missing end date', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: validFields({ endDate: undefined }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid date format', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: validFields({ startDate: '2030-01-01' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_date')).toBe(true)
  })

  it('rejects an impossible calendar date', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: validFields({ endDate: '2030/13/40' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_date')).toBe(true)
  })

  it('rejects an end date before the start date', async () => {
    const result = await validate(
      makeCtx([{ name: 'f', fields: validFields({ startDate: '2030/02/01', endDate: '2030/01/01' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_range')).toBe(true)
  })

  it('rejects a missing applies-to scope', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: validFields({ appliesTo: undefined }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unknown applies-to scope', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: validFields({ appliesTo: 'Everything' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_applies_to')).toBe(true)
  })

  it('rejects a missing reason', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: validFields({ reason: undefined }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('warns (does not block) when the freeze also blocks customer changes', async () => {
    const result = await validate(
      makeCtx([{ name: 'f', fields: validFields({ appliesTo: 'Customer and Splunk Initiated Changes' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'freezes_customer_changes')).toBe(true)
  })

  it('warns on a past-dated start', async () => {
    const result = await validate(
      makeCtx([{ name: 'f', fields: validFields({ startDate: '2020/01/01', endDate: '2020/01/05' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'past_start')).toBe(true)
  })

  it('warns on a very long freeze', async () => {
    const result = await validate(
      makeCtx([{ name: 'f', fields: validFields({ startDate: '2030/01/01', endDate: '2030/06/01' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'long_freeze')).toBe(true)
  })
})
