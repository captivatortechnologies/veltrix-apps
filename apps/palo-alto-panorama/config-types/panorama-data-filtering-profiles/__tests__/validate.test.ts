import validate, {
  extractDataFilteringSpecs,
  buildDataFilteringFields,
  dataFilteringDriftDiffs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-data-filtering-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-data-filtering-profiles',
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

describe('Panorama Data Filtering Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal profile with a data object', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'ssn-filter', data_object: 'ssn-pattern' } }]))
    expect(result.valid).toBe(true)
  })

  it('requires a data object', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', data_object: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.data_object'))).toBe(true)
  })

  it('rejects an unsupported direction', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', data_object: 'p', direction: 'sideways' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_direction')).toBe(true)
  })

  it('warns when block threshold is lower than alert threshold', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'x', data_object: 'p', alert_threshold: 20, block_threshold: 5 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'threshold_order')).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'df1', data_object: 'p' } },
        { name: 'b', fields: { name: 'DF1', data_object: 'p' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('builds REST fields with profile-level data-capture and a single rule', () => {
    const spec = extractDataFilteringSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', data_object: 'ssn-pattern', data_capture: true } }]).canvas,
    )[0]
    const fields = buildDataFilteringFields(spec) as { 'data-capture': string; rules: { entry: Array<Record<string, unknown>> } }
    expect(fields['data-capture']).toBe('yes')
    const rule = fields.rules.entry[0]
    expect(rule['data-object']).toBe('ssn-pattern')
    expect(rule['alert-threshold']).toBe(10)
    expect(rule['block-threshold']).toBe(20)
    expect(rule.application).toEqual({ member: ['any'] })
  })

  it('detects data-object and threshold drift', () => {
    const spec = extractDataFilteringSpecs(makeCtx([{ name: 'r', fields: { name: 'x', data_object: 'ssn-pattern' } }]).canvas)[0]
    const clean = dataFilteringDriftDiffs(spec, {
      '@name': 'x',
      'data-capture': 'no',
      rules: {
        entry: [
          {
            '@name': 'default',
            'data-object': 'ssn-pattern',
            direction: 'both',
            application: { member: ['any'] },
            'file-type': { member: ['any'] },
            'alert-threshold': 10,
            'block-threshold': 20,
            'log-severity': 'medium',
          },
        ],
      },
    })
    expect(clean).toHaveLength(0)
    const drifted = dataFilteringDriftDiffs(spec, {
      '@name': 'x',
      rules: { entry: [{ '@name': 'default', 'data-object': 'cc-pattern', 'alert-threshold': 5 }] },
    })
    expect(drifted.some((d) => d.field.endsWith('.data-object'))).toBe(true)
    expect(drifted.some((d) => d.field.endsWith('.alert-threshold'))).toBe(true)
  })
})
