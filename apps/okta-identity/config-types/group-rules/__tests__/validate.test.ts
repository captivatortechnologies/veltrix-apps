import validate, {
  extractGroupRuleSpecs,
  normalizeGroupIds,
  sameGroupIds,
  liveGroupIds,
  liveExpression,
  MAX_GROUP_RULE_NAME_LENGTH,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'group-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'group-rules',
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

const VALID_FIELDS = {
  name: 'Engineering Rule',
  expression: 'user.department=="Engineering"',
  groupIds: ['00g1a2b3c4D5e6F7g8h9'],
  status: 'ACTIVE',
}

describe('Okta Group Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: { ...VALID_FIELDS } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a rule whose groupIds arrive as a comma/space string', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Rule',
          fields: { ...VALID_FIELDS, groupIds: '00g1a2b3c4D5e6F7g8h9, 00gABCDEFGHIJKLMNOPQ' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const { name, ...rest } = VALID_FIELDS
    void name
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...rest } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing expression', async () => {
    const { expression, ...rest } = VALID_FIELDS
    void expression
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...rest } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('expression'))).toBe(true)
  })

  it('rejects missing groupIds', async () => {
    const { groupIds, ...rest } = VALID_FIELDS
    void groupIds
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...rest } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('groupIds'))).toBe(true)
  })

  it('rejects an empty groupIds array', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, groupIds: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('groupIds'))).toBe(true)
  })

  it('rejects a name longer than 50 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, name: 'x'.repeat(MAX_GROUP_RULE_NAME_LENGTH + 1) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a duplicate rule name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { ...VALID_FIELDS } },
        { name: 'sec2', fields: { ...VALID_FIELDS } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('allows two rules with different names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { ...VALID_FIELDS, name: 'Rule A' } },
        { name: 'sec2', fields: { ...VALID_FIELDS, name: 'Rule B' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractGroupRuleSpecs', () => {
  it('trims fields, normalizes groupIds and defaults status to ACTIVE', () => {
    const specs = extractGroupRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'okta-identity',
      entityType: 'group-rules',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Eng Rule  ',
            expression: '  user.department=="Eng"  ',
            groupIds: ['  00gAAA  ', '', '00gBBB'],
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Eng Rule')
    expect(specs[0].expression).toBe('user.department=="Eng"')
    expect(specs[0].groupIds).toEqual(['00gAAA', '00gBBB'])
    expect(specs[0].status).toBe('ACTIVE')
  })

  it('honours an explicit INACTIVE status (case-insensitive)', () => {
    const specs = extractGroupRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'okta-identity',
      entityType: 'group-rules',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'R', expression: 'x', groupIds: ['00g'], status: 'inactive' } }],
      snapshot: {},
    })
    expect(specs[0].status).toBe('INACTIVE')
  })
})

describe('normalizeGroupIds', () => {
  it('accepts an array and drops empty entries', () => {
    expect(normalizeGroupIds(['00gA', '', '  00gB  '])).toEqual(['00gA', '00gB'])
  })
  it('splits a comma/space-separated string', () => {
    expect(normalizeGroupIds('00gA, 00gB  00gC')).toEqual(['00gA', '00gB', '00gC'])
  })
  it('returns an empty array for a non-string, non-array value', () => {
    expect(normalizeGroupIds(undefined)).toEqual([])
    expect(normalizeGroupIds(null)).toEqual([])
  })
})

describe('sameGroupIds', () => {
  it('is true for the same set regardless of order', () => {
    expect(sameGroupIds(['a', 'b'], ['b', 'a'])).toBe(true)
  })
  it('is false when the sets differ', () => {
    expect(sameGroupIds(['a', 'b'], ['a', 'c'])).toBe(false)
    expect(sameGroupIds(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('liveGroupIds / liveExpression', () => {
  it('reads the assignUserToGroups.groupIds action', () => {
    expect(liveGroupIds({ actions: { assignUserToGroups: { groupIds: ['00gA', '00gB'] } } })).toEqual([
      '00gA',
      '00gB',
    ])
  })
  it('returns an empty array when the actions block is absent', () => {
    expect(liveGroupIds({})).toEqual([])
  })
  it('reads the conditions.expression.value', () => {
    expect(liveExpression({ conditions: { expression: { value: 'user.email!=null' } } })).toBe('user.email!=null')
  })
  it('returns an empty string when the expression is absent', () => {
    expect(liveExpression({})).toBe('')
  })
})
