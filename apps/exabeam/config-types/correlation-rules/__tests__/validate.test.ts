import validate, { extractRuleSpecs, parseRuleSpec, type RuleSpec } from '../validate'
import { buildRuleBody, stripReadOnlyRuleFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const VALID_SEQUENCES = JSON.stringify({
  sequences: [
    {
      name: 'Repeated failed logins',
      query: 'activity_type:"user-login-failure"',
      condition: { groupByOption: true, groupBy: ['user'], functionType: 'count', operator: 'greater_than', value: '5', time: 10, unit: 'minutes' },
    },
  ],
  outcomes: { alert: {} },
})

function makeItems(items: Array<{ id?: string; fields: Record<string, unknown> }>) {
  return items.map((it, i) => ({ id: it.id ?? `item-${i}`, name: `Item ${i}`, fields: it.fields }))
}

function makeCtx(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  const built = makeItems(items)
  return {
    appId: 'exabeam',
    customerId: 'cust-1',
    configTypeId: 'correlation-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'exabeam',
      entityType: 'correlation-rules',
      items: built,
      sections: built,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function makeCanvas(items: Array<{ id?: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  const built = makeItems(items)
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'exabeam',
    entityType: 'correlation-rules',
    items: built,
    sections: built,
    snapshot: {},
  }
}

describe('Exabeam Correlation Rules Validate Handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal rule', async () => {
    const result = await validate(
      makeCtx([{ fields: { name: 'Brute Force', severity: 'high', sequencesConfigJson: VALID_SEQUENCES } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a fully-populated rule', async () => {
    const result = await validate(
      makeCtx([
        {
          fields: {
            name: 'Impossible Travel',
            description: 'Detects logins from geographically implausible locations',
            severity: 'critical',
            enabled: true,
            testMode: false,
            sequencesConfigJson: VALID_SEQUENCES,
            suppressConfigJson: JSON.stringify({ suppress: true, time: 60, unit: 'minutes' }),
            delayConfigJson: JSON.stringify({ delay: 15, unit: 'minutes' }),
            scheduleConfigJson: JSON.stringify({ recurrences: [{ type: 'daily', startTime: '00:00', endTime: '23:59' }] }),
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ fields: { severity: 'high', sequencesConfigJson: VALID_SEQUENCES } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 128 characters', async () => {
    const result = await validate(
      makeCtx([{ fields: { name: 'x'.repeat(129), severity: 'high', sequencesConfigJson: VALID_SEQUENCES } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a duplicate rule name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { fields: { name: 'Brute Force', severity: 'high', sequencesConfigJson: VALID_SEQUENCES } },
        { fields: { name: 'brute force', severity: 'low', sequencesConfigJson: VALID_SEQUENCES } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a missing or invalid severity', async () => {
    const result = await validate(makeCtx([{ fields: { name: 'Rule A', sequencesConfigJson: VALID_SEQUENCES } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.severity') && e.code === 'required')).toBe(true)
  })

  it('rejects a missing sequencesConfigJson', async () => {
    const result = await validate(makeCtx([{ fields: { name: 'Rule A', severity: 'high' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.sequencesConfigJson') && e.code === 'required')).toBe(true)
  })

  it('rejects invalid JSON in sequencesConfigJson', async () => {
    const result = await validate(
      makeCtx([{ fields: { name: 'Rule A', severity: 'high', sequencesConfigJson: '{not valid json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a sequencesConfig with no sequences array', async () => {
    const result = await validate(
      makeCtx([{ fields: { name: 'Rule A', severity: 'high', sequencesConfigJson: JSON.stringify({ outcomes: {} }) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_sequences_config')).toBe(true)
  })

  it('rejects a sequence missing query or condition', async () => {
    const result = await validate(
      makeCtx([
        {
          fields: {
            name: 'Rule A',
            severity: 'high',
            sequencesConfigJson: JSON.stringify({ sequences: [{ name: 'seq1' }] }),
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'invalid_sequences_config').length).toBeGreaterThan(1)
  })

  it('rejects a multi-sequence rule missing commonProperties', async () => {
    const result = await validate(
      makeCtx([
        {
          fields: {
            name: 'Rule A',
            severity: 'high',
            sequencesConfigJson: JSON.stringify({
              sequences: [
                { query: 'a:1', condition: {} },
                { query: 'b:2', condition: {} },
              ],
            }),
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes('commonProperties'))).toBe(true)
  })

  it('rejects invalid JSON in suppressConfigJson/delayConfigJson/scheduleConfigJson', async () => {
    const result = await validate(
      makeCtx([
        {
          fields: {
            name: 'Rule A',
            severity: 'high',
            sequencesConfigJson: VALID_SEQUENCES,
            suppressConfigJson: 'not json',
            delayConfigJson: '[]',
            scheduleConfigJson: '"just a string"',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'invalid_json').length).toBeGreaterThan(2)
  })
})

describe('extractRuleSpecs', () => {
  it('trims fields, lower-cases severity, and defaults booleans to false', () => {
    const specs = extractRuleSpecs(
      makeCanvas([{ fields: { name: '  Brute Force  ', severity: 'HIGH', sequencesConfigJson: VALID_SEQUENCES } }]),
    )
    expect(specs[0].name).toBe('Brute Force')
    expect(specs[0].severity).toBe('high')
    expect(specs[0].enabled).toBe(false)
    expect(specs[0].testMode).toBe(false)
  })

  it('rejects an invalid severity value back to empty string', () => {
    const specs = extractRuleSpecs(makeCanvas([{ fields: { name: 'Rule A', severity: 'super-critical' } }]))
    expect(specs[0].severity).toBe('')
  })

  it('carries the canvas item id through as itemId', () => {
    const specs = extractRuleSpecs(makeCanvas([{ id: 'abc-123', fields: { name: 'Rule A' } }]))
    expect(specs[0].itemId).toBe('abc-123')
  })
})

describe('parseRuleSpec', () => {
  const baseSpec: RuleSpec = {
    itemId: 'item-1',
    name: 'Rule A',
    severity: 'high',
    enabled: false,
    testMode: false,
    sequencesConfigJson: VALID_SEQUENCES,
    suppressConfigJson: '',
    delayConfigJson: '',
    scheduleConfigJson: '',
  }

  it('parses sequencesConfig and omits unset optional configs', () => {
    const errors: Array<{ field: string; message: string; code: string }> = []
    const parsed = parseRuleSpec(baseSpec, 'items[0]', errors)
    expect(errors).toHaveLength(0)
    expect(parsed?.sequencesConfig).toEqual(JSON.parse(VALID_SEQUENCES))
    expect(parsed?.suppressConfig).toBeUndefined()
    expect(parsed?.delayConfig).toBeUndefined()
    expect(parsed?.scheduleConfig).toBeUndefined()
  })

  it('returns null and an error when sequencesConfigJson is blank', () => {
    const errors: Array<{ field: string; message: string; code: string }> = []
    const parsed = parseRuleSpec({ ...baseSpec, sequencesConfigJson: '' }, 'items[0]', errors)
    expect(parsed).toBeNull()
    expect(errors[0].code).toBe('required')
  })
})

describe('buildRuleBody', () => {
  it('always sends name/severity/enabled/testMode/sequencesConfig, omitting unset optionals', () => {
    const body = buildRuleBody({
      itemId: 'item-1',
      name: 'Rule A',
      severity: 'high',
      enabled: true,
      testMode: false,
      sequencesConfigJson: VALID_SEQUENCES,
      suppressConfigJson: '',
      delayConfigJson: '',
      scheduleConfigJson: '',
      sequencesConfig: JSON.parse(VALID_SEQUENCES),
    })
    expect(body).toEqual({
      name: 'Rule A',
      severity: 'high',
      enabled: true,
      testMode: false,
      sequencesConfig: JSON.parse(VALID_SEQUENCES),
    })
  })

  it('includes description/suppressConfig/delayConfig/scheduleConfig when set', () => {
    const body = buildRuleBody({
      itemId: 'item-1',
      name: 'Rule A',
      description: 'A description',
      severity: 'high',
      enabled: true,
      testMode: false,
      sequencesConfigJson: VALID_SEQUENCES,
      suppressConfigJson: '',
      delayConfigJson: '',
      scheduleConfigJson: '',
      sequencesConfig: JSON.parse(VALID_SEQUENCES),
      suppressConfig: { suppress: true },
      delayConfig: { delay: 15 },
      scheduleConfig: { recurrences: [] },
    })
    expect(body.description).toBe('A description')
    expect(body.suppressConfig).toEqual({ suppress: true })
    expect(body.delayConfig).toEqual({ delay: 15 })
    expect(body.scheduleConfig).toEqual({ recurrences: [] })
  })
})

describe('stripReadOnlyRuleFields', () => {
  it('removes id/author/lastModifier/createdAt/updatedAt/lastTriggeredAt/timesTriggered/timesSuppressed/autoDisabled but keeps the rest', () => {
    const stripped = stripReadOnlyRuleFields({
      id: 'rule-123',
      name: 'Rule A',
      description: 'desc',
      severity: 'high',
      enabled: true,
      testMode: false,
      sequencesConfig: { sequences: [] },
      author: 'jdoe@example.com',
      lastModifier: 'jdoe@example.com',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      lastTriggeredAt: '2026-01-03T00:00:00Z',
      timesTriggered: 42,
      timesSuppressed: 3,
      autoDisabled: false,
    })
    expect(stripped).toEqual({
      name: 'Rule A',
      description: 'desc',
      severity: 'high',
      enabled: true,
      testMode: false,
      sequencesConfig: { sequences: [] },
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.author).toBeUndefined()
  })
})
