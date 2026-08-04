import validate, { buildScanAuthParams, extractScanDefinitionSpecs, scanNameKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'defender-endpoint',
    customerId: 'cust-1',
    configTypeId: 'mde-scan-definitions',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'defender-endpoint',
      entityType: 'mde-scan-definitions',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000' },
    platform: stubPlatform,
  }
}

const DEVICE_ID = '1e5bc9d7e413ddd7902c2932e418702b84d0cc07'

const baseCommunityFields = {
  scan_name: 'Corp network scan',
  target: ['10.0.0.1', '10.0.0.2'],
  interval_hours: 4,
  scanner_agent_device_type: 'id',
  scanner_agent_device: DEVICE_ID,
  auth_mode: 'CommunityString',
  community_string: 'public',
}

describe('Defender Scan Definitions Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a well-formed community-string scan', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: baseCommunityFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a community string for CommunityString mode', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...baseCommunityFields, community_string: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('community_string'))).toBe(true)
  })

  it('requires username + auth protocol + auth password for AuthNoPriv', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...baseCommunityFields, auth_mode: 'AuthNoPriv', community_string: undefined } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('username'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('auth_protocol'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('auth_password'))).toBe(true)
  })

  it('requires priv protocol + priv password for AuthPriv', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: { ...baseCommunityFields, auth_mode: 'AuthPriv', username: 'scanner', auth_protocol: 'SHA1', auth_password: 'x' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('priv_protocol'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('priv_password'))).toBe(true)
  })

  it('skips inline credential requirements when Key Vault is used', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: { ...baseCommunityFields, community_string: undefined, use_key_vault: true, keyvault_url: 'https://kv.vault.azure.net', keyvault_secret_name: 'snmp-secret' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires Key Vault URL and secret name when Use Azure Key Vault is enabled', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...baseCommunityFields, community_string: undefined, use_key_vault: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('keyvault_url'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('keyvault_secret_name'))).toBe(true)
  })

  it('requires at least one target', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...baseCommunityFields, target: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('target'))).toBe(true)
  })

  it('rejects a non-positive interval', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...baseCommunityFields, interval_hours: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_interval')).toBe(true)
  })

  it('rejects a malformed scanner device id', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...baseCommunityFields, scanner_agent_device: 'not-a-hex-id' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_device_id')).toBe(true)
  })

  it('rejects the same scan name declared twice (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: baseCommunityFields },
        { name: 'b', fields: { ...baseCommunityFields, scan_name: 'CORP NETWORK SCAN' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_scan_name')).toBe(true)
  })

  it('extract joins targets and defaults target_type/interval', () => {
    const specs = extractScanDefinitionSpecs(makeCtx([{ name: 't', fields: { scan_name: 'x', target: 'a, b ,c' } }]).canvas)
    expect(specs[0].targets).toEqual(['a', 'b', 'c'])
    expect(specs[0].targetType).toBe('Ip')
    expect(specs[0].intervalHours).toBe(24)
  })

  it('buildScanAuthParams builds a Key Vault reference when useKeyVault is set', () => {
    const specs = extractScanDefinitionSpecs(
      makeCtx([{ name: 't', fields: { ...baseCommunityFields, community_string: undefined, use_key_vault: true, keyvault_url: 'https://kv', keyvault_secret_name: 'sec' } }])
        .canvas,
    )
    const params = buildScanAuthParams(specs[0])
    expect(params['@odata.type']).toBe('#microsoft.windowsDefenderATP.api.SnmpAuthParams')
    expect(params.KeyVaultUrl).toBe('https://kv')
    expect(params.KeyVaultSecretName).toBe('sec')
    expect(params.CommunityString).toBeUndefined()
  })

  it('buildScanAuthParams builds inline community-string params', () => {
    const specs = extractScanDefinitionSpecs(makeCtx([{ name: 't', fields: baseCommunityFields }]).canvas)
    const params = buildScanAuthParams(specs[0])
    expect(params.type).toBe('CommunityString')
    expect(params.CommunityString).toBe('public')
    expect(params.Username).toBeUndefined()
  })

  it('scanNameKey normalizes case for identity comparison', () => {
    expect(scanNameKey('Corp Scan')).toBe(scanNameKey('corp scan'))
  })
})
