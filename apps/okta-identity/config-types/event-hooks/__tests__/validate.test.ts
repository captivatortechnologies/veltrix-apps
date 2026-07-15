import validate, {
  DEFAULT_AUTH_HEADER_KEY,
  extractEventHookSpecs,
  normalizeHeaders,
  parseHeadersArray,
  preserveSecret,
  toStringList,
} from '../validate'
import {
  buildEventHookBody,
  channelChanged,
  headersFingerprint,
  stripReadOnlyEventHookFields,
  type EventHookRollbackEntry,
} from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import type { LiveEventHook as LiveHook } from '../validate'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'event-hooks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'event-hooks',
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
    entityType: 'event-hooks',
    items: sections,
    sections,
    snapshot: {},
  }
}

/** Fields for a fully valid event hook, overridable per test. */
function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'User Lifecycle',
    status: 'ACTIVE',
    eventItems: ['user.lifecycle.create', 'user.lifecycle.deactivate'],
    uri: 'https://example.com/okta/hook',
    authHeaderKey: 'Authorization',
    authHeaderValue: 'super-secret-token',
    ...over,
  }
}

describe('Okta Event Hooks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully valid event hook with no warnings', async () => {
    const result = await validate(makeCtx([{ name: 'Hook', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('accepts an optional extra-headers JSON array', async () => {
    const result = await validate(
      makeCtx([{ name: 'Hook', fields: validFields({ headersJson: '[{"key":"X-Trace","value":"prod"}]' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: 'x'.repeat(256) }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ status: 'PAUSED' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects a hook with no subscribed event types', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ eventItems: [] }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('eventItems'))).toBe(true)
  })

  it('warns (does not reject) on a suspicious event-type name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ eventItems: ['NotAnEventType'] }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'suspicious_event_type')).toBe(true)
  })

  it('rejects a missing channel URI', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ uri: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('uri'))).toBe(true)
  })

  it('rejects a non-HTTPS channel URI', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ uri: 'http://example.com/hook' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_uri')).toBe(true)
  })

  it('rejects a missing auth header value (write-only secret is required)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ authHeaderValue: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('authHeaderValue'))).toBe(true)
  })

  it('rejects headersJson that is not a JSON array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ headersJson: '{"key":"X"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_headers')).toBe(true)
  })

  it('rejects malformed headersJson', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ headersJson: '[not json' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_headers')).toBe(true)
  })

  it('rejects a header element with no key', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ headersJson: '[{"value":"v"}]' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_headers')).toBe(true)
  })

  it('rejects a duplicate hook name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ name: 'Audit' }) },
        { name: 'sec2', fields: validFields({ name: 'audit' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractEventHookSpecs', () => {
  it('trims fields, upper-cases the status, keeps the secret and parses tags', () => {
    const specs = extractEventHookSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: '  Audit Hook  ',
            status: ' inactive ',
            eventItems: ['user.lifecycle.create', 'user.lifecycle.delete'],
            uri: '  https://example.com/hook  ',
            authHeaderKey: '  X-Api-Key  ',
            authHeaderValue: '  token-with-edges  ',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('Audit Hook')
    expect(specs[0].status).toBe('INACTIVE')
    expect(specs[0].eventItems).toEqual(['user.lifecycle.create', 'user.lifecycle.delete'])
    expect(specs[0].uri).toBe('https://example.com/hook')
    expect(specs[0].authHeaderKey).toBe('X-Api-Key')
    // Secret is preserved verbatim (surrounding whitespace kept, only blank -> undefined).
    expect(specs[0].authHeaderValue).toBe('  token-with-edges  ')
  })

  it('defaults status to ACTIVE and authHeaderKey to Authorization when unset', () => {
    const specs = extractEventHookSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'H', eventItems: ['user.lifecycle.create'], uri: 'https://x' } }]),
    )
    expect(specs[0].status).toBe('ACTIVE')
    expect(specs[0].authHeaderKey).toBe(DEFAULT_AUTH_HEADER_KEY)
  })

  it('parses comma/newline event-type text into a list', () => {
    const specs = extractEventHookSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'H', eventItems: 'user.lifecycle.create, user.lifecycle.delete' } }]),
    )
    expect(specs[0].eventItems).toEqual(['user.lifecycle.create', 'user.lifecycle.delete'])
  })

  it('drops a blank headers blob to undefined', () => {
    const specs = extractEventHookSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'H', headersJson: '   ' } }]))
    expect(specs[0].headersJson).toBeUndefined()
  })
})

describe('toStringList / preserveSecret', () => {
  it('normalises an array and a delimited string', () => {
    expect(toStringList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(toStringList('a,b\nc')).toEqual(['a', 'b', 'c'])
    expect(toStringList(42)).toEqual([])
  })
  it('preserves a secret verbatim but blanks whitespace-only', () => {
    expect(preserveSecret(' tok en ')).toBe(' tok en ')
    expect(preserveSecret('   ')).toBeUndefined()
    expect(preserveSecret(123)).toBeUndefined()
  })
})

describe('parseHeadersArray / normalizeHeaders', () => {
  it('parses a JSON array', () => {
    expect(parseHeadersArray('[{"key":"a","value":"1"}]')).toEqual([{ key: 'a', value: '1' }])
  })
  it('rejects a JSON object and malformed JSON', () => {
    expect(parseHeadersArray('{"key":"a"}')).toBe(null)
    expect(parseHeadersArray('[nope')).toBe(null)
  })
  it('keeps only well-formed {key,value} entries', () => {
    const headers = normalizeHeaders([
      { key: ' X-A ', value: '1' },
      { key: '', value: 'skip' },
      { key: 'X-B' },
      'junk',
      { value: 'no-key' },
    ])
    expect(headers).toEqual([
      { key: 'X-A', value: '1' },
      { key: 'X-B', value: '' },
    ])
  })
})

describe('buildEventHookBody', () => {
  it('builds the full events + channel body and includes the secret when present', () => {
    const body = buildEventHookBody(
      {
        sectionName: 's',
        name: 'Audit',
        status: 'ACTIVE',
        eventItems: ['user.lifecycle.create'],
        uri: 'https://example.com/hook',
        authHeaderKey: 'Authorization',
        authHeaderValue: 'secret-token',
      },
      [{ key: 'X-Trace', value: 'prod' }],
    )
    expect(body).toEqual({
      name: 'Audit',
      events: { type: 'EVENT_TYPE', items: ['user.lifecycle.create'] },
      channel: {
        type: 'HTTP',
        version: '1.0.0',
        config: {
          uri: 'https://example.com/hook',
          authScheme: { type: 'HEADER', key: 'Authorization', value: 'secret-token' },
          headers: [{ key: 'X-Trace', value: 'prod' }],
        },
      },
    })
  })

  it('omits the auth value when blank and falls back to the default header key', () => {
    const body = buildEventHookBody(
      {
        sectionName: 's',
        name: 'Audit',
        status: 'ACTIVE',
        eventItems: ['user.lifecycle.create'],
        uri: 'https://example.com/hook',
        authHeaderKey: '',
        authHeaderValue: undefined,
      },
      [],
    )
    const channel = body.channel as { config: { authScheme: Record<string, unknown>; headers?: unknown } }
    expect(channel.config.authScheme).toEqual({ type: 'HEADER', key: DEFAULT_AUTH_HEADER_KEY })
    expect('value' in channel.config.authScheme).toBe(false)
    // No headers key when there are no extra headers.
    expect('headers' in channel.config).toBe(false)
  })
})

describe('channelChanged', () => {
  const live: LiveHook = {
    id: 'evh1',
    name: 'Audit',
    status: 'ACTIVE',
    events: { type: 'EVENT_TYPE', items: ['user.lifecycle.create'] },
    channel: {
      type: 'HTTP',
      version: '1.0.0',
      config: {
        uri: 'https://example.com/hook',
        authScheme: { type: 'HEADER', key: 'Authorization' },
        headers: [{ key: 'X-Trace', value: 'prod' }],
      },
    },
  }
  const baseSpec = {
    sectionName: 's',
    name: 'Audit',
    status: 'ACTIVE',
    eventItems: ['user.lifecycle.create'],
    uri: 'https://example.com/hook',
    authHeaderKey: 'Authorization',
    authHeaderValue: 'secret',
  }

  it('is false when the channel matches (secret ignored)', () => {
    expect(channelChanged(baseSpec, [{ key: 'X-Trace', value: 'prod' }], live)).toBe(false)
  })
  it('detects a URI change', () => {
    expect(channelChanged({ ...baseSpec, uri: 'https://example.com/other' }, [{ key: 'X-Trace', value: 'prod' }], live)).toBe(true)
  })
  it('detects an auth header key change', () => {
    expect(channelChanged({ ...baseSpec, authHeaderKey: 'X-Api-Key' }, [{ key: 'X-Trace', value: 'prod' }], live)).toBe(true)
  })
  it('detects an extra-headers change', () => {
    expect(channelChanged(baseSpec, [], live)).toBe(true)
  })
})

describe('headersFingerprint', () => {
  it('is order-insensitive', () => {
    expect(headersFingerprint([{ key: 'a', value: '1' }, { key: 'b', value: '2' }])).toBe(
      headersFingerprint([{ key: 'b', value: '2' }, { key: 'a', value: '1' }]),
    )
  })
  it('differs when a value differs', () => {
    const same =
      headersFingerprint([{ key: 'a', value: '1' }]) === headersFingerprint([{ key: 'a', value: '2' }])
    expect(same).toBe(false)
  })
})

describe('stripReadOnlyEventHookFields', () => {
  it('removes id/created/lastUpdated/verificationStatus/_links/_embedded/status but keeps events + channel', () => {
    const stripped = stripReadOnlyEventHookFields({
      id: 'evh1',
      name: 'Audit',
      status: 'ACTIVE',
      verificationStatus: 'VERIFIED',
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      _embedded: {},
      events: { type: 'EVENT_TYPE', items: ['user.lifecycle.create'] },
      channel: { type: 'HTTP', version: '1.0.0', config: { uri: 'https://example.com/hook' } },
    })
    expect(stripped).toEqual({
      name: 'Audit',
      events: { type: 'EVENT_TYPE', items: ['user.lifecycle.create'] },
      channel: { type: 'HTTP', version: '1.0.0', config: { uri: 'https://example.com/hook' } },
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.status).toBeUndefined()
    expect(stripped.verificationStatus).toBeUndefined()
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: EventHookRollbackEntry | null = null
void _rollbackEntryType
