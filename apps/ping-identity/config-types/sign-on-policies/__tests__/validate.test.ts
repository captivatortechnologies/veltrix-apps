import validate, {
  actionPriority,
  actionType,
  checkActionRequiredFields,
  extractPolicySpecs,
  parseActionsArray,
  stripReadOnly,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'ping-identity',
    customerId: 'cust-1',
    configTypeId: 'sign-on-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'ping-identity',
      entityType: 'sign-on-policies',
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

const LOGIN_ACTION = '[{"priority":1,"type":"LOGIN","recovery":{"enabled":true}}]'
const MFA_ACTION =
  '[{"priority":2,"type":"MULTI_FACTOR_AUTHENTICATION","deviceAuthenticationPolicy":{"id":"mfa-1"}}]'
const IDP_ACTION = '[{"priority":1,"type":"IDENTITY_PROVIDER","identityProvider":{"id":"idp-1"}}]'
const AGREEMENT_ACTION = '[{"priority":1,"type":"AGREEMENT","agreement":{"id":"agr-1"}}]'
const PROFILING_ACTION =
  '[{"priority":1,"type":"PROGRESSIVE_PROFILING","attributes":[{"name":"name.given","required":true}],"promptText":"Complete your profile","preventMultiplePromptsPerFlow":false,"promptIntervalSeconds":3600}]'

describe('PingOne Sign-On Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal policy with only a name', async () => {
    const result = await validate(makeCtx([{ name: 'Policy', fields: { name: 'Default Sign-On' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a policy marked as default', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { name: 'Corp Sign-On', default: true } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a policy with a LOGIN action', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { name: 'Corp Sign-On', actionsJson: LOGIN_ACTION } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a policy with a MULTI_FACTOR_AUTHENTICATION action', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { name: 'Corp Sign-On', actionsJson: MFA_ACTION } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a policy with an IDENTITY_PROVIDER action', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { name: 'Corp Sign-On', actionsJson: IDP_ACTION } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a policy with an AGREEMENT action', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { name: 'Corp Sign-On', actionsJson: AGREEMENT_ACTION } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a policy with a PROGRESSIVE_PROFILING action', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { name: 'Corp Sign-On', actionsJson: PROFILING_ACTION } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a multi-step actions array with distinct priorities', async () => {
    const actionsJson = JSON.stringify([
      { priority: 1, type: 'LOGIN', recovery: { enabled: true } },
      { priority: 2, type: 'MULTI_FACTOR_AUTHENTICATION', deviceAuthenticationPolicy: { id: 'mfa-1' } },
    ])
    const result = await validate(makeCtx([{ name: 'Policy', fields: { name: 'Corp Sign-On', actionsJson } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 256 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(257) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a duplicate policy name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Corp Sign-On' } },
        { name: 'sec2', fields: { name: 'Corp Sign-On' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects actionsJson that is a JSON object, not an array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Corp', actionsJson: '{"priority":1,"type":"LOGIN"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_actions')).toBe(true)
  })

  it('rejects actionsJson that is malformed JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Corp', actionsJson: '[not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_actions')).toBe(true)
  })

  it('rejects an action element that is not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Corp', actionsJson: '["oops"]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects an action with no priority', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Corp', actionsJson: '[{"type":"LOGIN"}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'priority_required')).toBe(true)
  })

  it('rejects duplicate priorities within a policy', async () => {
    const actionsJson = JSON.stringify([
      { priority: 1, type: 'LOGIN' },
      { priority: 1, type: 'IDENTIFIER_FIRST' },
    ])
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Corp', actionsJson } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_priority')).toBe(true)
  })

  it('rejects an action with no type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Corp', actionsJson: '[{"priority":1}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'type_required')).toBe(true)
  })

  it('rejects an unsupported action type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Corp', actionsJson: '[{"priority":1,"type":"BOGUS"}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action_type')).toBe(true)
  })

  it('rejects the PingID workforce-only action types with a specific message', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Corp', actionsJson: '[{"priority":1,"type":"PINGID_AUTHENTICATION"}]' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'unsupported_pingid_type')).toBe(true)
  })

  it('rejects a MULTI_FACTOR_AUTHENTICATION action missing deviceAuthenticationPolicy.id', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'Corp', actionsJson: '[{"priority":1,"type":"MULTI_FACTOR_AUTHENTICATION"}]' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_action_field')).toBe(true)
  })

  it('rejects an IDENTITY_PROVIDER action missing identityProvider.id', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Corp', actionsJson: '[{"priority":1,"type":"IDENTITY_PROVIDER"}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_action_field')).toBe(true)
  })

  it('rejects an AGREEMENT action missing agreement.id', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Corp', actionsJson: '[{"priority":1,"type":"AGREEMENT"}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_action_field')).toBe(true)
  })

  it('rejects a PROGRESSIVE_PROFILING action missing required fields', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Corp', actionsJson: '[{"priority":1,"type":"PROGRESSIVE_PROFILING"}]' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_action_field')).toBe(true)
  })
})

describe('extractPolicySpecs', () => {
  it('trims fields, drops empty optionals and reads the default flag', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'ping-identity',
      entityType: 'sign-on-policies',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Corp Sign-On  ',
            description: '  ',
            default: true,
            actionsJson: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Corp Sign-On')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].default).toBe(true)
    expect(specs[0].actionsJson).toBeUndefined()
  })

  it('defaults the default flag to false when absent', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'ping-identity',
      entityType: 'sign-on-policies',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'Corp' } }],
      snapshot: {},
    })
    expect(specs[0].default).toBe(false)
  })
})

describe('parseActionsArray', () => {
  it('parses a JSON array', () => {
    expect(parseActionsArray('[{"priority":1,"type":"LOGIN"}]')).toEqual([{ priority: 1, type: 'LOGIN' }])
  })
  it('rejects a JSON object', () => {
    expect(parseActionsArray('{"priority":1}')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseActionsArray('[nope')).toBe(null)
  })
})

describe('actionPriority', () => {
  it('reads a numeric priority', () => {
    expect(actionPriority({ priority: 3 })).toBe(3)
  })
  it('returns null for a missing or non-numeric priority', () => {
    expect(actionPriority({ priority: '3' })).toBe(null)
    expect(actionPriority({})).toBe(null)
    expect(actionPriority('x')).toBe(null)
  })
})

describe('actionType', () => {
  it('reads and trims the type', () => {
    expect(actionType({ type: '  LOGIN  ' })).toBe('LOGIN')
  })
  it('returns empty for a non-object or typeless action', () => {
    expect(actionType('x')).toBe('')
    expect(actionType({ priority: 1 })).toBe('')
  })
})

describe('checkActionRequiredFields', () => {
  it('passes a LOGIN action with no extra fields', () => {
    expect(checkActionRequiredFields({ priority: 1, type: 'LOGIN' })).toBe(null)
  })
  it('flags a MULTI_FACTOR_AUTHENTICATION action missing deviceAuthenticationPolicy', () => {
    expect(checkActionRequiredFields({ priority: 1, type: 'MULTI_FACTOR_AUTHENTICATION' })).toBeTruthy()
  })
  it('passes a MULTI_FACTOR_AUTHENTICATION action with deviceAuthenticationPolicy.id', () => {
    expect(
      checkActionRequiredFields({
        priority: 1,
        type: 'MULTI_FACTOR_AUTHENTICATION',
        deviceAuthenticationPolicy: { id: 'mfa-1' },
      }),
    ).toBe(null)
  })
  it('flags a PROGRESSIVE_PROFILING action missing attributes', () => {
    expect(
      checkActionRequiredFields({
        priority: 1,
        type: 'PROGRESSIVE_PROFILING',
        promptText: 'x',
        preventMultiplePromptsPerFlow: false,
        promptIntervalSeconds: 60,
      }),
    ).toBeTruthy()
  })
  it('passes a fully-specified PROGRESSIVE_PROFILING action', () => {
    expect(
      checkActionRequiredFields({
        priority: 1,
        type: 'PROGRESSIVE_PROFILING',
        attributes: [{ name: 'name.given', required: true }],
        promptText: 'x',
        preventMultiplePromptsPerFlow: false,
        promptIntervalSeconds: 60,
      }),
    ).toBe(null)
  })
})

describe('stripReadOnly', () => {
  it('drops the given fields and keeps the rest', () => {
    const stripped = stripReadOnly(
      { id: 'p1', name: 'Corp', environment: { id: 'env-1' }, createdAt: 'x', updatedAt: 'y', _links: {} },
      ['id', 'environment', 'createdAt', 'updatedAt', '_links'],
    )
    expect(stripped).toEqual({ name: 'Corp' })
  })
})
