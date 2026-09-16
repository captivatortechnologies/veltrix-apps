// =============================================================================
// Deploy handler tests against a FAKE Defender API.
//
// Scan definitions are the one config type in this app that sends a SECRET (an
// SNMP community string or password) in its request body. The properties under
// test are therefore both functional and security-critical: the credential goes
// to Defender on every deploy, and it never comes back out in rollbackData,
// which the platform persists.
// =============================================================================

import deploy from '../deploy'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { ScanDefinitionRollbackEntry } from '../deploy'
import { MACHINE_ID, apiError, deployCtx, mockMdeFetch, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-scan-definitions'
const SCAN_NAME = 'Datacenter switches'
const COMMUNITY_STRING = 'super-secret-community'
const SCAN_PATH = '/api/DeviceAuthenticatedScanDefinitions'

const isScanList = (url: string): boolean => url.includes(SCAN_PATH)

function item(fields: Record<string, unknown> = {}, name = 'Datacenter switches'): CanvasItemSnapshot {
  return {
    name,
    fields: {
      scan_name: SCAN_NAME,
      is_active: true,
      interval_hours: 24,
      target_type: 'Ip',
      target: '10.0.0.1, 10.0.0.2',
      scanner_agent_device_type: 'id',
      scanner_agent_device: MACHINE_ID,
      auth_mode: 'CommunityString',
      community_string: COMMUNITY_STRING,
      ...fields,
    },
  }
}

/** No live definitions; the scanner device resolves; the create succeeds. */
const emptyTenant = (method: string, url: string) => {
  if (method === 'GET' && isScanList(url)) return { status: 200, body: { value: [] } }
  if (method === 'GET') return { status: 200, body: { id: MACHINE_ID, computerDnsName: 'scanner01.contoso.com' } }
  return { status: 201, body: { id: 'scan-new' } }
}

const rollbackEntries = (result: { rollbackData?: unknown }): ScanDefinitionRollbackEntry[] =>
  (result.rollbackData as { previousState?: ScanDefinitionRollbackEntry[] })?.previousState ?? []

describe('Defender Scan Definitions Deploy Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item()], { credential: null }))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Client ID')
    expect(calls).toHaveLength(0)
  })

  it('lists definitions, resolves the scanner device, then creates the definition', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item()]))

    const vendor = vendorCalls(calls)
    expect(vendor[0].method).toBe('GET')
    expect(vendor[0].url).toContain(SCAN_PATH)
    expect(vendor[1].method).toBe('GET')
    expect(vendor[1].url).toContain(`/api/machines/${MACHINE_ID}`)
    expect(vendor[2].method).toBe('POST')
    expect(vendor[2].body).toEqual({
      scanType: 'Network',
      scanName: SCAN_NAME,
      isActive: true,
      target: '10.0.0.1,10.0.0.2',
      targetType: 'Ip',
      intervalInHours: 24,
      scannerAgent: { machineId: MACHINE_ID },
      scanAuthenticationParams: {
        '@odata.type': '#microsoft.windowsDefenderATP.api.SnmpAuthParams',
        type: 'CommunityString',
        CommunityString: COMMUNITY_STRING,
      },
    })
    expect(result.success).toBe(true)
    expect(result.message).toContain('1 created, 0 updated')
  })

  it('never persists the SNMP secret in the rollback state the platform stores', async () => {
    mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(JSON.stringify(result.rollbackData).includes(COMMUNITY_STRING)).toBe(false)
    expect(JSON.stringify(result.artifacts).includes(COMMUNITY_STRING)).toBe(false)
    expect(result.message.includes(COMMUNITY_STRING)).toBe(false)
  })

  it('records a created definition by the server-assigned id so rollback can delete it', async () => {
    mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(rollbackEntries(result)).toHaveLength(1)
    expect(rollbackEntries(result)[0].existed).toBe(false)
    expect(rollbackEntries(result)[0].id).toBe('scan-new')
    expect(rollbackEntries(result)[0].prior).toBeUndefined()
  })

  it('fails loudly when Defender creates a definition but echoes no id to record', async () => {
    mockMdeFetch((method, url) => {
      if (method === 'GET' && isScanList(url)) return { status: 200, body: { value: [] } }
      if (method === 'GET') return { status: 200, body: { id: MACHINE_ID } }
      return { status: 201, body: {} }
    })
    const result = await deploy(deployCtx(TYPE, [item()]))

    // An un-recorded definition could never be rolled back — silence would be worse.
    expect(result.success).toBe(false)
    expect(result.message).toContain('cannot record it for rollback')
  })

  it('updates a definition that already exists, matching the scan name case-insensitively', async () => {
    const live = {
      id: 'scan-live',
      scanName: SCAN_NAME.toUpperCase(),
      isActive: false,
      target: '10.9.9.9',
      targetType: 'Ip',
      intervalInHours: 12,
      scannerAgent: { machineId: 'f'.repeat(40) },
    }
    const calls = mockMdeFetch((method, url) => {
      if (method === 'GET' && isScanList(url)) return { status: 200, body: { value: [live] } }
      if (method === 'GET') return { status: 200, body: { id: MACHINE_ID } }
      return { status: 200, body: live }
    })
    const result = await deploy(deployCtx(TYPE, [item()]))

    const patch = vendorCalls(calls).find((c) => c.method === 'PATCH')
    expect(patch?.url).toContain(`${SCAN_PATH}/scan-live`)
    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(result.message).toContain('0 created, 1 updated')
  })

  it('re-sends the credential on an update, since Defender never returns it to compare', async () => {
    const live = { id: 'scan-live', scanName: SCAN_NAME, isActive: true, target: '10.0.0.1,10.0.0.2', targetType: 'Ip', intervalInHours: 24 }
    const calls = mockMdeFetch((method, url) => {
      if (method === 'GET' && isScanList(url)) return { status: 200, body: { value: [live] } }
      if (method === 'GET') return { status: 200, body: { id: MACHINE_ID } }
      return { status: 200, body: live }
    })
    await deploy(deployCtx(TYPE, [item()]))

    const patch = vendorCalls(calls).find((c) => c.method === 'PATCH')
    const auth = (patch?.body as Record<string, unknown>).scanAuthenticationParams as Record<string, unknown>
    expect(auth.CommunityString).toBe(COMMUNITY_STRING)
  })

  it('captures only the NON-SECRET prior fields of an updated definition', async () => {
    const live = {
      id: 'scan-live',
      scanName: SCAN_NAME,
      isActive: false,
      target: '10.9.9.9',
      targetType: 'Hostname',
      intervalInHours: 12,
      scannerAgent: { machineId: 'f'.repeat(40) },
    }
    mockMdeFetch((method, url) => {
      if (method === 'GET' && isScanList(url)) return { status: 200, body: { value: [live] } }
      if (method === 'GET') return { status: 200, body: { id: MACHINE_ID } }
      return { status: 200, body: live }
    })
    const result = await deploy(deployCtx(TYPE, [item()]))

    const prior = rollbackEntries(result)[0].prior
    expect(rollbackEntries(result)[0].existed).toBe(true)
    expect(prior).toEqual({
      scanName: SCAN_NAME,
      isActive: false,
      target: '10.9.9.9',
      targetType: 'Hostname',
      intervalInHours: 12,
      scannerMachineId: 'f'.repeat(40),
    })
  })

  it('builds an AuthPriv credential from the canvas rather than sending a community string', async () => {
    const calls = mockMdeFetch(emptyTenant)
    await deploy(
      deployCtx(TYPE, [
        item({
          auth_mode: 'AuthPriv',
          username: 'snmp-user',
          auth_protocol: 'SHA1',
          auth_password: 'auth-pass',
          priv_protocol: 'AES',
          priv_password: 'priv-pass',
        }),
      ]),
    )

    const auth = ((vendorCalls(calls).find((c) => c.method === 'POST')?.body as Record<string, unknown>)
      .scanAuthenticationParams) as Record<string, unknown>
    expect(auth.type).toBe('AuthPriv')
    expect(auth.Username).toBe('snmp-user')
    expect(auth.AuthProtocol).toBe('SHA1')
    expect(auth.PrivProtocol).toBe('AES')
    expect('CommunityString' in auth).toBe(false)
  })

  it('sends a Key Vault reference instead of the secret when the canvas asks for one', async () => {
    const calls = mockMdeFetch(emptyTenant)
    await deploy(
      deployCtx(TYPE, [
        item({ use_key_vault: true, keyvault_url: 'https://kv.vault.azure.net', keyvault_secret_name: 'snmp' }),
      ]),
    )

    const auth = ((vendorCalls(calls).find((c) => c.method === 'POST')?.body as Record<string, unknown>)
      .scanAuthenticationParams) as Record<string, unknown>
    expect(auth.KeyVaultUrl).toBe('https://kv.vault.azure.net')
    expect(auth.KeyVaultSecretName).toBe('snmp')
    expect('CommunityString' in auth).toBe(false)
  })

  it('refuses to guess when a computer name matches more than one scanner device', async () => {
    const calls = mockMdeFetch((method, url) => {
      if (method === 'GET' && isScanList(url)) return { status: 200, body: { value: [] } }
      if (method === 'GET') {
        return { status: 200, body: { value: [{ id: MACHINE_ID }, { id: 'f'.repeat(40) }] } }
      }
      return { status: 201, body: { id: 'scan-new' } }
    })
    const result = await deploy(
      deployCtx(TYPE, [item({ scanner_agent_device_type: 'name', scanner_agent_device: 'scanner01' })]),
    )

    // A scan definition has exactly ONE scanner agent: "apply to all" is wrong here.
    expect(result.success).toBe(false)
    expect(result.message).toContain('matched 2 devices')
    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('fails without writing when the scanner device does not exist', async () => {
    const calls = mockMdeFetch((method, url) => {
      if (method === 'GET' && isScanList(url)) return { status: 200, body: { value: [] } }
      if (method === 'GET') return { status: 404, body: apiError('ResourceNotFound') }
      return { status: 201, body: { id: 'scan-new' } }
    })
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Failed to resolve scanner device')
    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('returns a FAILED result instead of throwing when Defender rejects the create', async () => {
    mockMdeFetch((method, url) => {
      if (method === 'GET' && isScanList(url)) return { status: 200, body: { value: [] } }
      if (method === 'GET') return { status: 200, body: { id: MACHINE_ID } }
      return { status: 403, body: apiError('Machine.ReadWrite.All is required') }
    })
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Machine.ReadWrite.All is required')
    expect(result.message).toContain('failed after 0 of 1')
  })

  it('writes nothing when the live definitions cannot be read', async () => {
    const calls = mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Failed to list scan definitions')
    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('skips canvas items with no scan name or no target', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(
      deployCtx(TYPE, [{ name: 'blank', fields: {} }, { name: 'no target', fields: { scan_name: 'x' } }, item()]),
    )

    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(result.success).toBe(true)
  })
})
