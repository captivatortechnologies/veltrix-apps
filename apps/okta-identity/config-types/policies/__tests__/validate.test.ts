import validate, {
  buildConditions,
  extractPolicySpecs,
  parseRulesArray,
  parseSettingsObject,
  ruleName,
  stripReadOnly,
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
    configTypeId: 'policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'policies',
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

const PASSWORD_SETTINGS = '{"password":{"complexity":{"minLength":12},"age":{"maxAgeDays":90}}}'
const MFA_SETTINGS = '{"type":"AUTHENTICATORS","authenticators":[{"key":"okta_email","enroll":{"self":"REQUIRED"}}]}'
const VALID_RULES = '[{"name":"Require MFA","type":"SIGN_ON","actions":{"signon":{"access":"ALLOW"}}}]'

describe('Okta Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid OKTA_SIGN_ON policy (no settings)', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { type: 'OKTA_SIGN_ON', name: 'Corp Session', status: 'ACTIVE' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid PASSWORD policy with settings JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { type: 'PASSWORD', name: 'Strong Passwords', settingsJson: PASSWORD_SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid MFA_ENROLL policy with settings JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { type: 'MFA_ENROLL', name: 'Enroll Email', settingsJson: MFA_SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a policy with a rules JSON array and group scoping', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Policy',
          fields: {
            type: 'OKTA_SIGN_ON',
            name: 'Corp Session',
            groupIncludeIds: ['00g111', '00g222'],
            rulesJson: VALID_RULES,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Corp Session' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an invalid type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'ACCESS_POLICY', name: 'Corp Session' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'PASSWORD' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'PASSWORD', name: 'x'.repeat(256) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects the reserved "Default Policy" name (protected system default)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'PASSWORD', name: 'default policy' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_policy')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'PASSWORD', name: 'Strong', status: 'ENABLED' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects settings that are not valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'PASSWORD', name: 'Strong', settingsJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects settings that are a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'PASSWORD', name: 'Strong', settingsJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('warns (but stays valid) when OKTA_SIGN_ON carries settings that will be ignored', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'OKTA_SIGN_ON', name: 'Corp', settingsJson: '{"foo":1}' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'settings_ignored')).toBe(true)
  })

  it('rejects rules that are not a JSON array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'PASSWORD', name: 'Strong', rulesJson: '{"name":"x"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rules')).toBe(true)
  })

  it('rejects a rule element that is not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'PASSWORD', name: 'Strong', rulesJson: '["oops"]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule')).toBe(true)
  })

  it('rejects a rule with no name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'PASSWORD', name: 'Strong', rulesJson: '[{"actions":{}}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'rule_name_required')).toBe(true)
  })

  it('rejects duplicate rule names within a policy', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { type: 'PASSWORD', name: 'Strong', rulesJson: '[{"name":"r1"},{"name":"r1"}]' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('rejects a duplicate (type, name) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: 'PASSWORD', name: 'Strong' } },
        { name: 'sec2', fields: { type: 'PASSWORD', name: 'Strong' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('allows the same name under different policy types', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: 'PASSWORD', name: 'Corp' } },
        { name: 'sec2', fields: { type: 'MFA_ENROLL', name: 'Corp' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractPolicySpecs', () => {
  it('trims fields, drops empty optionals and parses the group list', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'okta-identity',
      entityType: 'policies',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            type: '  PASSWORD  ',
            name: '  Strong  ',
            description: '  ',
            status: 'active',
            groupIncludeIds: '00g111, 00g222',
            settingsJson: '',
            rulesJson: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].type).toBe('PASSWORD')
    expect(specs[0].name).toBe('Strong')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].status).toBe('ACTIVE')
    expect(specs[0].groupIncludeIds).toEqual(['00g111', '00g222'])
    expect(specs[0].settingsJson).toBeUndefined()
    expect(specs[0].rulesJson).toBeUndefined()
  })

  it('reads group ids from an array field', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'okta-identity',
      entityType: 'policies',
      items: [],
      sections: [{ name: 'sec1', fields: { type: 'OKTA_SIGN_ON', name: 'x', groupIncludeIds: ['00g1', '00g2'] } }],
      snapshot: {},
    })
    expect(specs[0].groupIncludeIds).toEqual(['00g1', '00g2'])
  })
})

describe('parseSettingsObject', () => {
  it('parses a JSON object', () => {
    expect(parseSettingsObject('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects a JSON array', () => {
    expect(parseSettingsObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseSettingsObject('{nope')).toBe(null)
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

describe('ruleName', () => {
  it('reads and trims a rule name', () => {
    expect(ruleName({ name: '  r1  ' })).toBe('r1')
  })
  it('returns empty for a non-object or nameless rule', () => {
    expect(ruleName('x')).toBe('')
    expect(ruleName({ actions: {} })).toBe('')
  })
})

describe('buildConditions', () => {
  it('builds people.groups.include from group ids', () => {
    expect(buildConditions(['00g1', '00g2'])).toEqual({
      people: { groups: { include: ['00g1', '00g2'] } },
    })
  })
  it('returns undefined for no groups', () => {
    expect(buildConditions([])).toBeUndefined()
  })
})

describe('stripReadOnly', () => {
  it('drops server-managed read-only fields (incl. status)', () => {
    const stripped = stripReadOnly({
      id: 'p1',
      name: 'Strong',
      status: 'ACTIVE',
      system: true,
      created: 'x',
      lastUpdated: 'y',
      _links: {},
      description: 'keep me',
    })
    expect(stripped).toEqual({ name: 'Strong', description: 'keep me' })
  })
})
