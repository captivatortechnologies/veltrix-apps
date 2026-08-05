import validate, { AUTH_RECORD_TYPES, authRecordBlockTag, authRecordKey, extractAuthRecordSpecs } from '../validate'
import { authRecordParams, authRecordPath, buildCreateParams, buildUpdateParams, normalizeIps, parseAuthRecordBlock } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const CREDS = '{"username":"svc-qualys","password":"hunter2"}'

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'qualys',
    customerId: 'cust-1',
    configTypeId: 'qualys-auth-records',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'qualys',
      entityType: 'qualys-auth-records',
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

describe('Qualys Authentication Records Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete auth record', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { record_type: 'unix', title: 'Prod Linux', ips: '10.0.0.1-10.0.0.50', credentials_json: CREDS } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an unsupported record type', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { record_type: 'exotic_db', title: 'x', ips: '10.0.0.1', credentials_json: CREDS } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value' && e.field.includes('record_type'))).toBe(true)
  })

  it('rejects missing title, ips and credentials', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { record_type: 'unix' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('title') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.includes('ips') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.includes('credentials_json') && e.code === 'invalid_json')).toBe(true)
  })

  it('rejects malformed credentials JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { record_type: 'unix', title: 'x', ips: '10.0.0.1', credentials_json: '{bad' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('allows the same title across different technologies (namespaced by type)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { record_type: 'unix', title: 'Prod', ips: '10.0.0.1', credentials_json: CREDS } },
        { name: 'b', fields: { record_type: 'windows', title: 'Prod', ips: '10.0.0.2', credentials_json: CREDS } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate (type, title) pairs case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { record_type: 'unix', title: 'Prod', ips: '10.0.0.1', credentials_json: CREDS } },
        { name: 'b', fields: { record_type: 'unix', title: 'prod', ips: '10.0.0.2', credentials_json: CREDS } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_auth_record')).toBe(true)
  })

  it('authRecordKey namespaces by type and lowercases the title', () => {
    expect(authRecordKey({ recordType: 'unix', title: 'Prod' })).toBe(authRecordKey({ recordType: 'unix', title: 'prod' }))
    expect(authRecordKey({ recordType: 'unix', title: 'Prod' }) === authRecordKey({ recordType: 'windows', title: 'Prod' })).toBe(false)
  })

  it('every AUTH_RECORD_TYPES entry resolves its own block tag', () => {
    for (const t of AUTH_RECORD_TYPES) {
      expect(authRecordBlockTag(t.value)).toBe(t.blockTag)
    }
    expect(authRecordBlockTag('unknown_type')).toBeUndefined()
  })

  it('authRecordPath builds the per-technology endpoint', () => {
    expect(authRecordPath('unix')).toBe('/api/2.0/fo/auth/unix/')
    expect(authRecordPath('ms_sql')).toBe('/api/2.0/fo/auth/ms_sql/')
  })

  it('normalizeIps collapses whitespace/commas', () => {
    expect(normalizeIps(' 10.0.0.1 ,  10.0.0.2\n10.0.0.3 ')).toBe('10.0.0.1,10.0.0.2,10.0.0.3')
    expect(normalizeIps('')).toBe('')
  })

  it('build params flatten credentials and never leak them under the wrong key', () => {
    const spec = extractAuthRecordSpecs(
      makeCtx([{ name: 't', fields: { record_type: 'unix', title: 'Prod', ips: '10.0.0.1,10.0.0.2', comments: 'note', credentials_json: CREDS } }])
        .canvas,
    )[0]

    const create = buildCreateParams(spec)
    expect(create.action).toBe('create')
    expect(create.title).toBe('Prod')
    expect(create.ips).toBe('10.0.0.1,10.0.0.2')
    expect(create.comments).toBe('note')
    expect(create.username).toBe('svc-qualys')
    expect(create.password).toBe('hunter2')

    const update = buildUpdateParams(spec, '789')
    expect(update.action).toBe('update')
    expect(update.ids).toBe('789')
    expect(update.title).toBe('Prod')

    const params = authRecordParams(spec)
    expect(params.action).toBeUndefined()
  })

  it('parseAuthRecordBlock reads id/title/comments from a repeating record block', () => {
    const block = '<ID>4561</ID><TITLE><![CDATA[Prod Linux]]></TITLE><USERNAME><![CDATA[svc]]></USERNAME><COMMENTS><![CDATA[note]]></COMMENTS>'
    const parsed = parseAuthRecordBlock(block)
    expect(parsed.id).toBe('4561')
    expect(parsed.title).toBe('Prod Linux')
    expect(parsed.comments).toBe('note')
    // Never exposes the credential-bearing fields on the parsed live shape.
    expect(Object.keys(parsed).includes('username')).toBe(false)
  })
})
