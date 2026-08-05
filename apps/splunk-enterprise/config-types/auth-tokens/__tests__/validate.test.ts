import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'auth-tokens',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Auth Token Canvas',
      toolType: 'splunk-enterprise',
      entityType: 'auth-tokens',
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

describe('Splunk API Access Token Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully specified token', async () => {
    const result = await validate(
      makeCtx([{
        name: 'sec1',
        fields: {
          username: 'svc-automation',
          audience: 'Veltrix automation',
          tokenType: 'static',
          expiresOn: '+90d',
          enabled: true,
        },
      }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing username', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { audience: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.username'))).toBe(true)
  })

  it('rejects invalid username format', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'bad user!', audience: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format' && e.field.endsWith('.username'))).toBe(true)
  })

  it('rejects missing audience', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'svc1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.audience'))).toBe(true)
  })

  it('detects duplicate (username, audience) pairs', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { username: 'svc1', audience: 'automation' } },
        { name: 'sec2', fields: { username: 'svc1', audience: 'automation' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('allows the same username with a different audience', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { username: 'svc1', audience: 'automation-a' } },
        { name: 'sec2', fields: { username: 'svc1', audience: 'automation-b' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects an unknown token type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'svc1', audience: 'x', tokenType: 'bogus' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type_value')).toBe(true)
  })

  it('accepts a relative expiresOn', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'svc1', audience: 'x', expiresOn: '+30d' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('accepts an absolute expiresOn', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'svc1', audience: 'x', expiresOn: '2027-01-01T00:00:00Z' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a malformed expiresOn', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'svc1', audience: 'x', expiresOn: 'next month' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format' && e.field.endsWith('.expiresOn'))).toBe(true)
  })

  it('warns when no expiration is set', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'svc1', audience: 'x' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_expiration_set')).toBe(true)
  })

  it('rejects a malformed notBefore', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'svc1', audience: 'x', expiresOn: '+30d', notBefore: 'tomorrow' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format' && e.field.endsWith('.notBefore'))).toBe(true)
  })

  it('rejects non-boolean enabled', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { username: 'svc1', audience: 'x', enabled: 'yes' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })
})
