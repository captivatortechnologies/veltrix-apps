import validate, { extractCredentialSpecs, credentialKey, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-shared-credentials',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-shared-credentials',
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

const validFields = {
  name: 'Linux Scanner',
  description: 'SSH scanner account',
  credential_json: '{"service":"ssh","username":"scanner","host":"10.0.0.1","port":22}',
  secret: 'super-secret-key',
}

describe('InsightVM Shared Credentials Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid shared credential', async () => {
    const result = await validate(makeCtx([{ name: 'Cred', fields: { ...validFields } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing name, credential_json and secret', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { description: 'nothing else' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('credential_json'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('secret'))).toBe(true)
  })

  it('rejects a missing secret even when name + account are present', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'X', credential_json: '{"service":"ssh"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('secret'))).toBe(true)
  })

  it('rejects invalid credential_json (array)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'X', credential_json: '[1,2]', secret: 'k' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate name case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Linux Scanner' } },
        { name: 'b', fields: { ...validFields, name: 'linux scanner' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_credential')).toBe(true)
  })

  it('extract trims fields, credentialKey is case-insensitive, and no error echoes the secret', async () => {
    expect(parseJsonObject('  ').error).toBeNull()
    expect(parseJsonObject('{"service":"ssh"}').value).toEqual({ service: 'ssh' })

    const specs = extractCredentialSpecs(
      makeCtx([{ name: 't', fields: { ...validFields, name: '  Linux Scanner  ', secret: '  top-secret  ' } }]).canvas,
    )
    expect(specs[0].name).toBe('Linux Scanner')
    expect(specs[0].secret).toBe('top-secret')
    expect(credentialKey(specs[0])).toBe(credentialKey({ name: 'LINUX SCANNER' }))

    // The validator must never surface the secret's value in any error/message.
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, secret: 'super-secret-key' } }]))
    expect(JSON.stringify(result).includes('super-secret-key')).toBe(false)
  })
})
