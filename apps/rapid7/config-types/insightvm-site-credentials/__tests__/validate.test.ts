import validate, {
  credentialKey,
  extractSiteCredentialSpecs,
  parseJsonObject,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-site-credentials',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-site-credentials',
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

const ACCOUNT = '{"service":"ssh","username":"scanner","port":22}'

function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { site_name: 'Prod', name: 'ssh-scanner', credential_json: ACCOUNT, secret: 'hunter2', ...over }
}

describe('InsightVM Site Credentials Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid site credential', async () => {
    const result = await validate(makeCtx([{ name: 'Site Credential', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing site/credential name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { credential_json: ACCOUNT, secret: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('site_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires credential_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ credential_json: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('credential_json'))).toBe(true)
  })

  it('rejects invalid credential_json (not an object)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ credential_json: 'not json' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('requires the secret', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ secret: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('secret'))).toBe(true)
  })

  it('rejects duplicate (site, credential name) case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: validFields({ site_name: 'Prod', name: 'ssh-scanner' }) },
        { name: 'b', fields: validFields({ site_name: 'prod', name: 'SSH-Scanner' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_credential')).toBe(true)
  })

  it('extract + helpers behave (secret preserved, key case-insensitive)', () => {
    expect(parseJsonObject('').value).toEqual({})
    expect(parseJsonObject('{"a":1}').value).toEqual({ a: 1 })
    expect(parseJsonObject('[]').error).toBeTruthy()
    const specs = extractSiteCredentialSpecs(
      makeCtx([{ name: 's', fields: validFields({ site_name: '  Prod  ', name: '  ssh-scanner  ', secret: '  keep me  ' }) }]).canvas,
    )
    expect(specs[0].siteName).toBe('Prod')
    expect(specs[0].name).toBe('ssh-scanner')
    // The secret must NOT be trimmed — surrounding characters can be significant.
    expect(specs[0].secret).toBe('  keep me  ')
    expect(credentialKey(specs[0])).toBe(credentialKey({ siteName: 'prod', name: 'SSH-SCANNER' }))
  })
})
