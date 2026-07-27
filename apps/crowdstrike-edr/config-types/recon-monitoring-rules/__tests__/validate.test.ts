import validate, { parseActions, extractReconRuleSpecs, actionKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'recon-monitoring-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'recon-monitoring-rules',
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

function validRuleFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Brand Impersonation',
    topic: 'SA_DOMAIN',
    filter: 'example.com',
    priority: 'high',
    permissions: 'private',
    breachMonitoring: false,
    substringMatching: false,
    actions: JSON.stringify([
      { type: 'email', frequency: 'asap', recipients: ['soc@example.com'], contentFormat: 'standard' },
    ]),
    ...overrides,
  }
}

describe('CrowdStrike Recon Monitoring Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: validRuleFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing rule name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validRuleFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ name: 'a'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects an unknown topic', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ topic: 'SA_UNKNOWN' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_topic')).toBe(true)
  })

  it('normalizes topic casing to upper case', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ topic: 'sa_domain' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing filter', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validRuleFields({ filter: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'sec1.filter' && e.code === 'required')).toBe(true)
  })

  it('rejects an unknown priority', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ priority: 'urgent' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('rejects unknown permissions', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ permissions: 'everyone' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_permissions')).toBe(true)
  })

  it('rejects invalid actions JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRuleFields({ actions: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_actions')).toBe(true)
  })

  it('rejects an action with a non-email recipient', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validRuleFields({
            actions: JSON.stringify([
              { type: 'email', frequency: 'asap', recipients: ['not-an-email'] },
            ]),
          }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_actions')).toBe(true)
  })

  it('warns when the actions array is empty', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validRuleFields({ actions: '[]' }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_actions')).toBe(true)
  })

  it('rejects duplicate rule names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validRuleFields() },
        { name: 'sec2', fields: validRuleFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseActions', () => {
  it('accepts a well-formed action', () => {
    const { actions, errors } = parseActions(
      JSON.stringify([
        { type: 'email', frequency: 'daily', recipients: ['a@b.com'], contentFormat: 'enhanced' },
      ]),
    )
    expect(errors).toHaveLength(0)
    expect(actions).toHaveLength(1)
    expect(actions[0].contentFormat).toBe('enhanced')
    expect(actions[0].frequency).toBe('daily')
  })

  it('defaults type to email and contentFormat to standard', () => {
    const { actions, errors } = parseActions(
      JSON.stringify([{ frequency: 'weekly', recipients: ['a@b.com'] }]),
    )
    expect(errors).toHaveLength(0)
    expect(actions[0].type).toBe('email')
    expect(actions[0].contentFormat).toBe('standard')
  })

  it('rejects a non-email recipient', () => {
    const { errors } = parseActions(
      JSON.stringify([{ type: 'email', frequency: 'asap', recipients: ['nope'] }]),
    )
    expect(errors.some((e) => e.includes('valid email'))).toBe(true)
  })

  it('rejects an unknown frequency', () => {
    const { errors } = parseActions(
      JSON.stringify([{ type: 'email', frequency: 'hourly', recipients: ['a@b.com'] }]),
    )
    expect(errors.some((e) => e.includes('frequency'))).toBe(true)
  })

  it('rejects an unknown contentFormat', () => {
    const { errors } = parseActions(
      JSON.stringify([
        { type: 'email', frequency: 'asap', recipients: ['a@b.com'], contentFormat: 'fancy' },
      ]),
    )
    expect(errors.some((e) => e.includes('contentFormat'))).toBe(true)
  })

  it('rejects empty recipients', () => {
    const { errors } = parseActions(
      JSON.stringify([{ type: 'email', frequency: 'asap', recipients: [] }]),
    )
    expect(errors.some((e) => e.includes('at least one'))).toBe(true)
  })

  it('rejects a non-array actions payload', () => {
    const { errors } = parseActions(JSON.stringify({ type: 'email' }))
    expect(errors.some((e) => e.includes('must be a JSON array'))).toBe(true)
  })

  it('rejects two actions that converge to the same live action', () => {
    const { errors } = parseActions(
      JSON.stringify([
        { type: 'email', frequency: 'asap', recipients: ['a@b.com'] },
        { type: 'email', frequency: 'asap', recipients: ['a@b.com'], contentFormat: 'enhanced' },
      ]),
    )
    expect(errors.some((e) => e.includes('duplicates'))).toBe(true)
  })

  it('returns empty actions for empty input', () => {
    expect(parseActions(undefined)).toEqual({ actions: [], errors: [] })
  })
})

describe('actionKey', () => {
  it('is order-insensitive and case-insensitive on recipients', () => {
    const a = actionKey({ type: 'email', frequency: 'asap', recipients: ['A@b.com', 'c@d.com'] })
    const b = actionKey({ type: 'EMAIL', frequency: 'asap', recipients: ['c@d.com', 'a@b.com'] })
    expect(a).toBe(b)
  })

  it('ignores content format so a format change is an update, not a recreate', () => {
    const a = actionKey({ type: 'email', frequency: 'daily', recipients: ['a@b.com'] })
    const b = actionKey({ type: 'email', frequency: 'weekly', recipients: ['a@b.com'] })
    expect(a === b).toBe(false)
  })
})

describe('extractReconRuleSpecs', () => {
  it('parses fields and normalizes topic and enum casing', () => {
    const specs = extractReconRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'recon-monitoring-rules',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: 'r1',
            topic: 'sa_ip',
            filter: '1.2.3.4',
            priority: 'LOW',
            permissions: 'PUBLIC',
            breachMonitoring: true,
            substringMatching: true,
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('r1')
    expect(specs[0].topic).toBe('SA_IP')
    expect(specs[0].priority).toBe('low')
    expect(specs[0].permissions).toBe('public')
    expect(specs[0].breachMonitoring).toBe(true)
    expect(specs[0].substringMatching).toBe(true)
  })

  it('defaults priority to medium and permissions to private when unset', () => {
    const specs = extractReconRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'recon-monitoring-rules',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'r1', topic: 'SA_DOMAIN', filter: 'x.com' } }],
      snapshot: {},
    })
    expect(specs[0].priority).toBe('medium')
    expect(specs[0].permissions).toBe('private')
  })
})
