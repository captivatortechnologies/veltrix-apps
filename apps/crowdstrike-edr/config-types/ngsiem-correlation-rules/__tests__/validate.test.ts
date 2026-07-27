import validate, { extractCorrelationRuleSpecs } from '../validate'
import { buildManagedFields, buildMitreAttack } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'ngsiem-correlation-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-correlation-rules',
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

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Suspicious IAM policy attachment',
    description: 'Detects risky IAM policy attachments in CloudTrail',
    search: '#event.module="cloudtrail" | event_name=AttachRolePolicy',
    severity: 'high',
    frequency: '1h',
    triggerMode: 'summary',
    mitreTactic: 'TA0004',
    mitreTechnique: 'T1098.003',
    status: 'active',
    createCase: true,
    publish: true,
    ...overrides,
  }
}

function canvasFrom(fields: Record<string, unknown>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'crowdstrike-edr',
    entityType: 'ngsiem-correlation-rules',
    items: [],
    sections: [{ name: 'sec1', fields }],
    snapshot: {},
  }
}

describe('CrowdStrike Correlation Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule configuration', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ name: 'x'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects a missing CQL search', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ search: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid severity', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ severity: 'urgent' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ status: 'paused' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects an invalid trigger mode', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ triggerMode: 'loud' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_trigger_mode')).toBe(true)
  })

  it('rejects a missing frequency', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ frequency: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unknown frequency', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ frequency: '3d' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_frequency')).toBe(true)
  })

  it('rejects duplicate rule names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('warns when a MITRE technique is set without a tactic', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ mitreTactic: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'mitre_tactic_missing')).toBe(true)
  })

  it('warns when an inactive rule is published', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ status: 'inactive', publish: true }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'publish_inactive')).toBe(true)
  })
})

describe('extractCorrelationRuleSpecs', () => {
  it('applies safe defaults and lowercases enum fields', () => {
    const specs = extractCorrelationRuleSpecs(
      canvasFrom({ name: 'R1', search: 'foo', severity: 'HIGH', triggerMode: 'VERBOSE', frequency: '6H' }),
    )
    expect(specs[0].name).toBe('R1')
    expect(specs[0].severity).toBe('high')
    expect(specs[0].triggerMode).toBe('verbose')
    expect(specs[0].frequency).toBe('6h')
    // status defaults to inactive; createCase/publish default to false
    expect(specs[0].status).toBe('inactive')
    expect(specs[0].createCase).toBe(false)
    expect(specs[0].publish).toBe(false)
  })

  it('defaults severity to medium and trigger mode to summary when omitted', () => {
    const specs = extractCorrelationRuleSpecs(canvasFrom({ name: 'R2', search: 'bar' }))
    expect(specs[0].severity).toBe('medium')
    expect(specs[0].triggerMode).toBe('summary')
  })
})

describe('buildManagedFields', () => {
  it('maps the named severity to the API int32 scale', () => {
    const [spec] = extractCorrelationRuleSpecs(canvasFrom(validFields({ severity: 'high' })))
    const body = buildManagedFields(spec)
    expect(body.severity).toBe(70)
  })

  it('carries status and the CQL query into search.filter', () => {
    const [spec] = extractCorrelationRuleSpecs(canvasFrom(validFields({ status: 'active' })))
    const body = buildManagedFields(spec)
    const search = body.search as Record<string, unknown>
    expect(body.status).toBe('active')
    expect(search.filter).toBe('#event.module="cloudtrail" | event_name=AttachRolePolicy')
    expect(search.execution_mode).toBe('scheduled')
  })

  it('expresses create_case as search.outcome', () => {
    const [withCase] = extractCorrelationRuleSpecs(canvasFrom(validFields({ createCase: true })))
    const [withoutCase] = extractCorrelationRuleSpecs(canvasFrom(validFields({ createCase: false })))
    expect((buildManagedFields(withCase).search as Record<string, unknown>).outcome).toBe('case')
    expect((buildManagedFields(withoutCase).search as Record<string, unknown>).outcome).toBe('detection')
  })

  it('encodes the frequency as an "@every" schedule definition', () => {
    const [spec] = extractCorrelationRuleSpecs(canvasFrom(validFields({ frequency: '6h' })))
    const body = buildManagedFields(spec)
    const operation = body.operation as Record<string, unknown>
    const schedule = operation.schedule as Record<string, unknown>
    expect(schedule.definition).toBe('@every 6h')
    expect((body.search as Record<string, unknown>).lookback).toBe('6h')
  })

  it('includes a mitre_attack mapping when a tactic or technique is set', () => {
    const [spec] = extractCorrelationRuleSpecs(canvasFrom(validFields()))
    const body = buildManagedFields(spec)
    expect(body.mitre_attack).toEqual([{ tactic_id: 'TA0004', technique_id: 'T1098.003' }])
  })

  it('omits mitre_attack when neither tactic nor technique is set', () => {
    const [spec] = extractCorrelationRuleSpecs(
      canvasFrom(validFields({ mitreTactic: '', mitreTechnique: '' })),
    )
    expect(buildManagedFields(spec).mitre_attack).toBeUndefined()
  })
})

describe('buildMitreAttack', () => {
  it('returns undefined when both tactic and technique are empty', () => {
    const [spec] = extractCorrelationRuleSpecs(
      canvasFrom(validFields({ mitreTactic: '', mitreTechnique: '' })),
    )
    expect(buildMitreAttack(spec)).toBeUndefined()
  })

  it('emits only the fields that are set', () => {
    const [spec] = extractCorrelationRuleSpecs(
      canvasFrom(validFields({ mitreTactic: 'TA0001', mitreTechnique: '' })),
    )
    expect(buildMitreAttack(spec)).toEqual([{ tactic_id: 'TA0001' }])
  })
})
