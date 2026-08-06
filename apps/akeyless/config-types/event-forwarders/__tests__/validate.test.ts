import validate, { extractEventForwarderSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'akeyless',
    customerId: 'cust-1',
    configTypeId: 'event-forwarders',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'akeyless',
      entityType: 'event-forwarders',
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

describe('Akeyless Event Forwarders Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal slack forwarder', async () => {
    const result = await validate(makeCtx([{ name: 'f1', fields: { name: 'sec-alerts', type: 'slack', webhookUrl: 'https://hooks.slack.com/x' } }]))
    expect(result.valid).toBe(true)
  })

  it('requires gatewaysEventSourceLocations and webhookUrlTeams for teams', async () => {
    const result = await validate(makeCtx([{ name: 'f1', fields: { name: 'teams-1', type: 'teams' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.gatewaysEventSourceLocations'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.webhookUrlTeams'))).toBe(true)
  })

  it('accepts a fully-specified teams forwarder', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'f1',
          fields: {
            name: 'teams-1',
            type: 'teams',
            gatewaysEventSourceLocations: ['http://localhost:8000'],
            webhookUrlTeams: 'https://outlook.office.com/webhook/x',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns (but does not fail) when an email forwarder has no recipients', async () => {
    const result = await validate(makeCtx([{ name: 'f1', fields: { name: 'em-1', type: 'email' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_recipients')).toBe(true)
  })

  it('rejects an invalid webhook authType', async () => {
    const result = await validate(makeCtx([{ name: 'f1', fields: { name: 'wh-1', type: 'webhook', authType: 'oauth' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.authType'))).toBe(true)
  })

  it('rejects an invalid servicenow serviceNowAuthType', async () => {
    const result = await validate(makeCtx([{ name: 'f1', fields: { name: 'sn-1', type: 'servicenow', serviceNowAuthType: 'saml' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.serviceNowAuthType'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'f1', fields: { name: 'dup', type: 'slack', webhookUrl: 'x' } },
        { name: 'f2', fields: { name: 'dup', type: 'slack', webhookUrl: 'x' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractEventForwarderSpecs', () => {
  it('defaults enable to true and runnerType to immediate', () => {
    const specs = extractEventForwarderSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'event-forwarders',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'x', type: 'slack' } }],
      snapshot: {},
    })
    expect(specs[0].enable).toBe(true)
    expect(specs[0].runnerType).toBe('immediate')
  })

  it('respects an explicit enable=false', () => {
    const specs = extractEventForwarderSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'event-forwarders',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'x', type: 'slack', enable: false } }],
      snapshot: {},
    })
    expect(specs[0].enable).toBe(false)
  })
})
