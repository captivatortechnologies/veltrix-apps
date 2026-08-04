import validate, { extractIntegrationSpecs, integrationKey, readBool, tryParseJson } from '../validate'
import { buildIntegrationInput, buildIntegrationParams } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'wiz',
    customerId: 'cust-1',
    configTypeId: 'wiz-integrations',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'wiz',
      entityType: 'wiz-integrations',
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

describe('Wiz Integrations Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid webhook integration', async () => {
    const result = await validate(
      makeCtx([{ name: 'I1', fields: { name: 'Ops Webhook', integration_type: 'WEBHOOK', webhook_url: 'https://example.com/hook' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name and integration_type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported integration type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'X', integration_type: 'CARRIER_PIGEON' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_integration_type')).toBe(true)
  })

  it('requires webhook_url for WEBHOOK', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'X', integration_type: 'WEBHOOK' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('webhook_url'))).toBe(true)
  })

  it('requires a connector id or role ARN for AWS_SNS depending on access method', async () => {
    const missingConnector = await validate(
      makeCtx([
        {
          name: 'i1',
          fields: { name: 'X', integration_type: 'AWS_SNS', aws_sns_topic_arn: 'arn:aws:sns:...', aws_sns_access_method_type: 'ASSUME_CONNECTOR_ROLE' },
        },
      ]),
    )
    expect(missingConnector.valid).toBe(false)
    expect(missingConnector.errors.some((e) => e.field.includes('aws_sns_access_connector_id'))).toBe(true)

    const withConnector = await validate(
      makeCtx([
        {
          name: 'i1',
          fields: {
            name: 'X',
            integration_type: 'AWS_SNS',
            aws_sns_topic_arn: 'arn:aws:sns:...',
            aws_sns_access_method_type: 'ASSUME_CONNECTOR_ROLE',
            aws_sns_access_connector_id: 'connector-1',
          },
        },
      ]),
    )
    expect(withConnector.valid).toBe(true)
  })

  it('requires either a Jira PAT or a username+password', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'X', integration_type: 'JIRA', jira_server_url: 'https://a.atlassian.net' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('jira_auth_password'))).toBe(true)
  })

  it('rejects duplicate integration names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Dup', integration_type: 'WEBHOOK', webhook_url: 'https://a.com' } },
        { name: 'b', fields: { name: 'dup', integration_type: 'WEBHOOK', webhook_url: 'https://b.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_integration')).toBe(true)
  })

  it('rejects malformed webhook headers JSON', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'i1',
          fields: { name: 'X', integration_type: 'WEBHOOK', webhook_url: 'https://a.com', webhook_headers_json: '[not json' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('extractIntegrationSpecs trims and defaults type/scope', () => {
    const specs = extractIntegrationSpecs(
      makeCtx([{ name: 'e', fields: { name: '  Integ  ', webhook_url: 'https://a.com' } }]).canvas,
    )
    expect(specs[0].name).toBe('Integ')
    expect(specs[0].integrationType).toBe('WEBHOOK')
    expect(specs[0].isAccessibleToAllProjects).toBe(true)
    expect(integrationKey('  Integ ')).toBe('integ')
  })

  it('helpers behave as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(tryParseJson('').ok).toBe(true)
    expect(tryParseJson('[bad').ok).toBe(false)
  })
})

describe('Wiz Integrations Deploy — request shape', () => {
  const ctx = makeCtx([
    {
      name: 'jira1',
      fields: {
        name: 'Jira Ticketing',
        integration_type: 'JIRA',
        jira_server_url: 'https://acme.atlassian.net',
        jira_auth_username: 'bot@acme.com',
        jira_auth_password: 'super-secret-token',
      },
    },
  ])

  it('builds a CreateIntegrationInput with the params keyed by type', () => {
    const spec = extractIntegrationSpecs(ctx.canvas)[0]
    const input = buildIntegrationInput(spec)
    expect(input.type).toBe('JIRA')
    expect(input.params).toEqual({
      jira: {
        serverUrl: 'https://acme.atlassian.net',
        serverType: 'CLOUD',
        isOnPrem: false,
        authorization: { username: 'bot@acme.com', password: 'super-secret-token' },
      },
    })
  })

  it('builds distinct params per integration type', () => {
    const slackSpec = extractIntegrationSpecs(
      makeCtx([{ name: 's1', fields: { name: 'Slack', integration_type: 'SLACK', slack_webhook_url: 'https://hooks.slack.com/x' } }]).canvas,
    )[0]
    expect(buildIntegrationParams(slackSpec)).toEqual({ slack: { url: 'https://hooks.slack.com/x' } })
  })
})
