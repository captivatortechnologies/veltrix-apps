import validate, { credentialIdentity, extractVpnCredentialSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-vpn-credentials',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-vpn-credentials',
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

describe('ZIA VPN Credentials Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid UFQDN credential', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'VPN Credential',
          fields: { type: 'UFQDN', fqdn: 'site1@acme.com', pre_shared_key: 's3cr3t!', comments: 'HQ tunnel' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid IP credential', async () => {
    const result = await validate(
      makeCtx([{ name: 'VPN Credential', fields: { type: 'IP', ip_address: '203.0.113.9', pre_shared_key: 'psk123' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { fqdn: 'site1@acme.com', pre_shared_key: 'psk' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects a UFQDN credential missing its fqdn', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'UFQDN', pre_shared_key: 'psk' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('fqdn'))).toBe(true)
  })

  it('rejects an IP credential missing its ip_address', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'IP', pre_shared_key: 'psk' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('ip_address'))).toBe(true)
  })

  it('rejects a credential missing the pre-shared key', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'UFQDN', fqdn: 'site1@acme.com' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('pre_shared_key'))).toBe(true)
  })

  it('rejects an unknown credential type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'CERT', fqdn: 'site1@acme.com', pre_shared_key: 'psk' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects duplicate identities (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { type: 'UFQDN', fqdn: 'Site1@acme.com', pre_shared_key: 'psk-a' } },
        { name: 'b', fields: { type: 'UFQDN', fqdn: 'site1@acme.com', pre_shared_key: 'psk-b' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_vpn_credential')).toBe(true)
  })

  it('allows a UFQDN and an IP credential to coexist', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { type: 'UFQDN', fqdn: 'site1@acme.com', pre_shared_key: 'psk-a' } },
        { name: 'b', fields: { type: 'IP', ip_address: '198.51.100.7', pre_shared_key: 'psk-b' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('extractVpnCredentialSpecs normalizes type, trims identity and preserves the PSK exactly', () => {
    const specs = extractVpnCredentialSpecs(
      makeCtx([
        {
          name: 'VPN Credential',
          fields: { type: ' ufqdn ', fqdn: '  site1@acme.com  ', comments: '   ', pre_shared_key: '  spaced psk  ' },
        },
      ]).canvas,
    )
    expect(specs[0].type).toBe('UFQDN')
    expect(specs[0].fqdn).toBe('site1@acme.com')
    expect(specs[0].comments).toBeUndefined()
    // A PSK's exact characters (incl. surrounding spaces) are preserved.
    expect(specs[0].preSharedKey).toBe('  spaced psk  ')
    expect(credentialIdentity(specs[0])).toBe('site1@acme.com')
  })
})
