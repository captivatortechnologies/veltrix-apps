import validate, { extractMappingSpecs, isValidAction, isValidCondition, parseNonEmptyArray } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'onelogin',
    customerId: 'cust-1',
    configTypeId: 'mappings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'onelogin',
      entityType: 'mappings',
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

const validConditions = '[{"source":"last_login","operator":">","value":"90"}]'
const validActions = '[{"action":"set_status","value":["2"]}]'

describe('OneLogin Mappings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid mapping', async () => {
    const result = await validate(
      makeCtx([{ name: 'Mapping', fields: { name: 'Suspend inactive', conditionsJson: validConditions, actionsJson: validActions } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { conditionsJson: validConditions, actionsJson: validActions } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate mapping name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Suspend inactive', conditionsJson: validConditions, actionsJson: validActions } },
        { name: 'sec2', fields: { name: 'Suspend inactive', conditionsJson: validConditions, actionsJson: validActions } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_mapping')).toBe(true)
  })

  it('rejects missing conditions', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'M', actionsJson: validActions } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('conditionsJson'))).toBe(true)
  })

  it('rejects an empty conditions array', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'M', conditionsJson: '[]', actionsJson: validActions } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_conditions')).toBe(true)
  })

  it('rejects a condition missing source/operator', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'M', conditionsJson: '[{"source":"last_login"}]', actionsJson: validActions } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_condition_shape')).toBe(true)
  })

  it('rejects missing actions', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'M', conditionsJson: validConditions } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('actionsJson'))).toBe(true)
  })

  it('rejects an action missing action/value', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'M', conditionsJson: validConditions, actionsJson: '[{"action":"set_status"}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action_shape')).toBe(true)
  })

  it('rejects malformed JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'M', conditionsJson: 'not json', actionsJson: validActions } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_conditions')).toBe(true)
  })
})

describe('extractMappingSpecs', () => {
  it('defaults enabled to true and match to "all"', () => {
    const specs = extractMappingSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onelogin',
      entityType: 'mappings',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'M', conditionsJson: validConditions, actionsJson: validActions } }],
      snapshot: {},
    })
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].match).toBe('all')
  })

  it('respects an explicit match: any and enabled: false', () => {
    const specs = extractMappingSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onelogin',
      entityType: 'mappings',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'M', match: 'any', enabled: false } }],
      snapshot: {},
    })
    expect(specs[0].match).toBe('any')
    expect(specs[0].enabled).toBe(false)
  })
})

describe('parseNonEmptyArray', () => {
  it('parses a non-empty array', () => {
    expect(parseNonEmptyArray('[1,2]')).toEqual([1, 2])
  })
  it('returns null for an empty array', () => {
    expect(parseNonEmptyArray('[]')).toBeNull()
  })
  it('returns null for malformed JSON', () => {
    expect(parseNonEmptyArray('not json')).toBeNull()
  })
  it('returns null for a non-array', () => {
    expect(parseNonEmptyArray('{"a":1}')).toBeNull()
  })
})

describe('isValidCondition / isValidAction', () => {
  it('accepts a well-formed condition', () => {
    expect(isValidCondition({ source: 'last_login', operator: '>', value: '90' })).toBe(true)
  })
  it('rejects a condition missing operator', () => {
    expect(isValidCondition({ source: 'last_login' })).toBe(false)
  })
  it('accepts a well-formed action', () => {
    expect(isValidAction({ action: 'set_status', value: ['2'] })).toBe(true)
  })
  it('rejects an action whose value is not an array', () => {
    expect(isValidAction({ action: 'set_status', value: '2' })).toBe(false)
  })
})
