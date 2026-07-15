import validate, {
  buildClientConditions,
  extractAuthServerPolicySpecs,
  parseRulesArray,
  resolveClientInclude,
  ruleName,
  ruleStatus,
  ruleType,
  stripReadOnly,
  toOptionalPriority,
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
    configTypeId: 'auth-server-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'auth-server-policies',
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

const VALID_RULES =
  '[{"name":"Default rule","priority":1,"conditions":{"grantTypes":{"include":["authorization_code"]},"scopes":{"include":["*"]}},"actions":{"token":{"accessTokenLifetimeMinutes":60}}}]'

describe('Okta Authorization-Server Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal policy (authServerId + name)', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { authServerId: 'default', name: 'Corp Access', status: 'ACTIVE' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a full policy with priority, client scoping and rules', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Policy',
          fields: {
            authServerId: 'aus1abc',
            name: 'Corp Access',
            description: 'Main policy',
            priority: 1,
            status: 'ACTIVE',
            clientInclude: ['ALL_CLIENTS'],
            rulesJson: VALID_RULES,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing authServerId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Corp Access' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('authServerId'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { authServerId: 'default' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name: 'x'.repeat(256) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('warns (but stays valid) for the reserved "Default Policy" system name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name: 'default policy' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'system_default_policy')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name: 'Corp', status: 'ENABLED' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects a non-numeric priority', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name: 'Corp', priority: 'high' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('rejects a priority below 1', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name: 'Corp', priority: 0 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('rejects rules that are not a JSON array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name: 'Corp', rulesJson: '{"name":"x"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rules')).toBe(true)
  })

  it('rejects a rule element that is not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name: 'Corp', rulesJson: '["oops"]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule')).toBe(true)
  })

  it('rejects a rule with no name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name: 'Corp', rulesJson: '[{"actions":{}}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'rule_name_required')).toBe(true)
  })

  it('rejects duplicate rule names within a policy', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { authServerId: 'default', name: 'Corp', rulesJson: '[{"name":"r1"},{"name":"r1"}]' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('warns (but stays valid) when a rule declares a non-RESOURCE_ACCESS type', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { authServerId: 'default', name: 'Corp', rulesJson: '[{"name":"r1","type":"SIGN_ON"}]' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'rule_type_forced')).toBe(true)
  })

  it('rejects a duplicate (authServerId, name) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { authServerId: 'default', name: 'Corp' } },
        { name: 'sec2', fields: { authServerId: 'default', name: 'Corp' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('allows the same name under different authorization servers', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { authServerId: 'default', name: 'Corp' } },
        { name: 'sec2', fields: { authServerId: 'aus1abc', name: 'Corp' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractAuthServerPolicySpecs', () => {
  it('trims fields, drops empty optionals and parses the client list', () => {
    const specs = extractAuthServerPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'okta-identity',
      entityType: 'auth-server-policies',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            authServerId: '  default  ',
            name: '  Corp  ',
            description: '  ',
            priority: '2',
            status: 'active',
            clientInclude: '0oa111, 0oa222',
            rulesJson: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].authServerId).toBe('default')
    expect(specs[0].name).toBe('Corp')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].priority).toBe(2)
    expect(specs[0].status).toBe('ACTIVE')
    expect(specs[0].clientInclude).toEqual(['0oa111', '0oa222'])
    expect(specs[0].rulesJson).toBeUndefined()
  })

  it('reads client ids from an array field', () => {
    const specs = extractAuthServerPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'okta-identity',
      entityType: 'auth-server-policies',
      items: [],
      sections: [
        { name: 'sec1', fields: { authServerId: 'default', name: 'x', clientInclude: ['0oa1', '0oa2'] } },
      ],
      snapshot: {},
    })
    expect(specs[0].clientInclude).toEqual(['0oa1', '0oa2'])
  })
})

describe('toOptionalPriority', () => {
  it('returns undefined for blank/absent', () => {
    expect(toOptionalPriority('')).toBeUndefined()
    expect(toOptionalPriority(undefined)).toBeUndefined()
    expect(toOptionalPriority(null)).toBeUndefined()
  })
  it('parses a number and a numeric string', () => {
    expect(toOptionalPriority(3)).toBe(3)
    expect(toOptionalPriority('4')).toBe(4)
  })
  it('returns NaN for a non-numeric string', () => {
    expect(Number.isNaN(toOptionalPriority('high') as number)).toBe(true)
  })
})

describe('parseRulesArray', () => {
  it('parses a JSON array', () => {
    expect(parseRulesArray('[{"name":"r1"}]')).toEqual([{ name: 'r1' }])
  })
  it('rejects a JSON object', () => {
    expect(parseRulesArray('{"name":"r1"}')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseRulesArray('[nope')).toBe(null)
  })
})

describe('ruleName / ruleStatus / ruleType', () => {
  it('reads and trims a rule name', () => {
    expect(ruleName({ name: '  r1  ' })).toBe('r1')
  })
  it('returns empty for a non-object or nameless rule', () => {
    expect(ruleName('x')).toBe('')
    expect(ruleName({ actions: {} })).toBe('')
  })
  it('defaults rule status to ACTIVE and uppercases', () => {
    expect(ruleStatus({ name: 'r1' })).toBe('ACTIVE')
    expect(ruleStatus({ name: 'r1', status: 'inactive' })).toBe('INACTIVE')
  })
  it('reads a rule type, or empty when absent', () => {
    expect(ruleType({ name: 'r1', type: 'RESOURCE_ACCESS' })).toBe('RESOURCE_ACCESS')
    expect(ruleType({ name: 'r1' })).toBe('')
  })
})

describe('resolveClientInclude / buildClientConditions', () => {
  it('defaults to ["ALL_CLIENTS"] when empty', () => {
    expect(resolveClientInclude([])).toEqual(['ALL_CLIENTS'])
    expect(buildClientConditions([])).toEqual({ clients: { include: ['ALL_CLIENTS'] } })
  })
  it('uses the provided client ids', () => {
    expect(resolveClientInclude(['0oa1'])).toEqual(['0oa1'])
    expect(buildClientConditions(['0oa1', '0oa2'])).toEqual({ clients: { include: ['0oa1', '0oa2'] } })
  })
})

describe('stripReadOnly', () => {
  it('drops server-managed read-only fields (incl. status)', () => {
    const stripped = stripReadOnly({
      id: 'p1',
      name: 'Corp',
      status: 'ACTIVE',
      system: true,
      created: 'x',
      lastUpdated: 'y',
      _links: {},
      description: 'keep me',
    })
    expect(stripped).toEqual({ name: 'Corp', description: 'keep me' })
  })
})
