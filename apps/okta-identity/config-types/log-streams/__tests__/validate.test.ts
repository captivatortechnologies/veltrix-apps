import validate, {
  extractLogStreamSpecs,
  isSplunk,
  parseConfigObject,
  preserveSecret,
} from '../validate'
import {
  buildLogStreamBody,
  stripReadOnlyLogStreamFields,
  type LogStreamRollbackEntry,
} from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'log-streams',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'log-streams',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'okta-identity',
    entityType: 'log-streams',
    items: sections,
    sections,
    snapshot: {},
  }
}

const AWS_SETTINGS = '{"accountId":"123456789012","eventSourceName":"okta-eventsource","region":"us-east-1"}'
const SPLUNK_SETTINGS = '{"host":"acme.splunkcloud.com","edition":"aws"}'

function awsFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'AWS Stream', type: 'aws_eventbridge', status: 'ACTIVE', settingsJson: AWS_SETTINGS, ...over }
}
function splunkFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Splunk Stream',
    type: 'splunk_cloud_logstreaming',
    status: 'ACTIVE',
    settingsJson: SPLUNK_SETTINGS,
    splunkToken: 'hec-token-123',
    ...over,
  }
}

describe('Okta Log Streams Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid AWS EventBridge stream', async () => {
    const result = await validate(makeCtx([{ name: 'S', fields: awsFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid Splunk stream with a token', async () => {
    const result = await validate(makeCtx([{ name: 'S', fields: splunkFields() }]))
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: awsFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unknown type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: awsFields({ type: 'kafka' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: awsFields({ status: 'PAUSED' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects missing settings JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: awsFields({ settingsJson: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('settingsJson'))).toBe(true)
  })

  it('rejects malformed settings JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: awsFields({ settingsJson: '{nope' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects an AWS stream with a non-12-digit accountId', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: awsFields({ settingsJson: '{"accountId":"123","eventSourceName":"x","region":"us-east-1"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_setting')).toBe(true)
  })

  it('rejects an AWS stream with an unsupported region', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: awsFields({ settingsJson: '{"accountId":"123456789012","eventSourceName":"x","region":"moon-1"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_setting')).toBe(true)
  })

  it('rejects a Splunk stream with an invalid edition', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: splunkFields({ settingsJson: '{"host":"acme.splunkcloud.com","edition":"azure"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_setting')).toBe(true)
  })

  it('warns when a Splunk stream has no token', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: splunkFields({ splunkToken: '' }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_token')).toBe(true)
  })

  it('warns when the token is placed in the settings JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: splunkFields({ settingsJson: '{"host":"acme.splunkcloud.com","edition":"aws","token":"oops"}' }) }]),
    )
    expect(result.warnings.some((w) => w.code === 'token_in_settings')).toBe(true)
  })

  it('rejects a duplicate stream name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: awsFields({ name: 'Stream' }) },
        { name: 'sec2', fields: awsFields({ name: 'stream' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractLogStreamSpecs', () => {
  it('trims fields, lower-cases the type, upper-cases the status and preserves the token', () => {
    const specs = extractLogStreamSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: '  Splunk Stream  ',
            type: ' SPLUNK_CLOUD_LOGSTREAMING ',
            status: ' inactive ',
            settingsJson: SPLUNK_SETTINGS,
            splunkToken: '  tok en  ',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('Splunk Stream')
    expect(specs[0].type).toBe('splunk_cloud_logstreaming')
    expect(specs[0].status).toBe('INACTIVE')
    expect(specs[0].splunkToken).toBe('  tok en  ')
  })
})

describe('buildLogStreamBody', () => {
  it('injects the Splunk token on create and strips a stray settings token', () => {
    const body = buildLogStreamBody(
      { sectionName: 's', name: 'Splunk', type: 'splunk_cloud_logstreaming', status: 'ACTIVE', splunkToken: 'hec' },
      { host: 'acme.splunkcloud.com', edition: 'aws', token: 'stray' },
      true,
    )
    expect(body).toEqual({
      type: 'splunk_cloud_logstreaming',
      name: 'Splunk',
      settings: { host: 'acme.splunkcloud.com', edition: 'aws', token: 'hec' },
    })
  })

  it('omits the token entirely on update (immutable/write-only)', () => {
    const body = buildLogStreamBody(
      { sectionName: 's', name: 'Splunk', type: 'splunk_cloud_logstreaming', status: 'ACTIVE', splunkToken: 'hec' },
      { host: 'acme.splunkcloud.com', edition: 'aws', token: 'stray' },
      false,
    )
    const settings = (body.settings ?? {}) as Record<string, unknown>
    expect('token' in settings).toBe(false)
    expect(settings).toEqual({ host: 'acme.splunkcloud.com', edition: 'aws' })
  })

  it('never adds a token for an AWS stream', () => {
    const body = buildLogStreamBody(
      { sectionName: 's', name: 'AWS', type: 'aws_eventbridge', status: 'ACTIVE', splunkToken: 'ignored' },
      { accountId: '123456789012', eventSourceName: 'x', region: 'us-east-1' },
      true,
    )
    const settings = (body.settings ?? {}) as Record<string, unknown>
    expect('token' in settings).toBe(false)
  })
})

describe('stripReadOnlyLogStreamFields', () => {
  it('removes id/created/lastUpdated/status/_links but keeps type/name/settings', () => {
    const stripped = stripReadOnlyLogStreamFields({
      id: 'lsn1',
      name: 'AWS',
      type: 'aws_eventbridge',
      status: 'ACTIVE',
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      settings: { accountId: '123456789012', eventSourceName: 'x', region: 'us-east-1' },
    })
    expect(stripped).toEqual({
      name: 'AWS',
      type: 'aws_eventbridge',
      settings: { accountId: '123456789012', eventSourceName: 'x', region: 'us-east-1' },
    })
    expect(stripped.status).toBeUndefined()
  })
})

describe('helpers', () => {
  it('isSplunk / parseConfigObject / preserveSecret behave', () => {
    expect(isSplunk('splunk_cloud_logstreaming')).toBe(true)
    expect(isSplunk('aws_eventbridge')).toBe(false)
    expect(parseConfigObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseConfigObject('[1,2]')).toBe(null)
    expect(preserveSecret('  tok  ')).toBe('  tok  ')
    expect(preserveSecret('   ')).toBeUndefined()
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: LogStreamRollbackEntry | null = null
void _rollbackEntryType
