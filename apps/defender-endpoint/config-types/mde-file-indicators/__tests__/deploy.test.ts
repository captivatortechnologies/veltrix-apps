// =============================================================================
// Deploy handler tests against a FAKE Defender API (lib/__tests__/mdeFakeApi).
//
// deploy / rollback / driftDetect / healthCheck for the three indicator config
// types are ONE shared implementation (lib/indicators.ts). This directory holds
// the full suite for it; the network and certificate suites cover their own
// wiring and their own indicator values.
// =============================================================================

import deploy from '../deploy'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { IndicatorRollbackEntry } from '../../../lib/indicators'
import { API_HOST, TENANT, TOKEN_PATH, apiError, deployCtx, mockMdeFetch, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-file-indicators'
const SHA256 = 'a'.repeat(64)
const SHA1 = 'b'.repeat(40)

function item(fields: Record<string, unknown> = {}, name = 'Known-bad installer'): CanvasItemSnapshot {
  return {
    name,
    fields: {
      indicator_type: 'FileSha256',
      indicator_value: SHA256,
      action: 'Block',
      severity: 'High',
      title: 'Known-bad installer',
      description: 'Blocked during IR-2317',
      ...fields,
    },
  }
}

/** No live indicators; every write accepted. */
const emptyTenant = (method: string) =>
  method === 'GET' ? { status: 200, body: { value: [] } } : { status: 201, body: { id: 'ind-new' } }

const rollbackEntries = (result: { rollbackData?: unknown }): IndicatorRollbackEntry[] =>
  (result.rollbackData as { previousState?: IndicatorRollbackEntry[] })?.previousState ?? []

describe('Defender File Indicators Deploy Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await deploy(deployCtx(TYPE, [item()], { credential: null }))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Client ID')
    expect(calls).toHaveLength(0)
  })

  it('refuses before touching Defender when the tenant id setting is missing', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await deploy(deployCtx(TYPE, [item()], { settings: {} }))

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/tenant id/i)
    expect(calls).toHaveLength(0)
  })

  it('authenticates first, for the LEGACY securitycenter audience rather than the request host', async () => {
    const calls = mockMdeFetch(emptyTenant)
    await deploy(deployCtx(TYPE, [item()]))

    expect(calls[0].url).toContain(`login.microsoftonline.com/${TENANT}${TOKEN_PATH}`)
    // A token minted for the request host (api.security.microsoft.com) is
    // rejected with 403 by the live API — the audience must be the legacy one.
    expect(String(calls[0].body)).toContain('scope=https%3A%2F%2Fapi.securitycenter.microsoft.com%2F.default')
    expect(String(calls[0].body)).toContain('grant_type=client_credentials')
    expect(vendorCalls(calls)[0].url).toContain(API_HOST)
  })

  it('reads the live indicators before writing, then creates one that does not exist yet', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item()]))

    const vendor = vendorCalls(calls)
    expect(vendor[0].method).toBe('GET')
    expect(vendor[0].url).toContain('/api/indicators')
    expect(vendor[1].method).toBe('POST')
    expect(vendor[1].url).toContain('/api/indicators')
    expect(vendor[1].body).toEqual({
      indicatorValue: SHA256,
      indicatorType: 'FileSha256',
      action: 'Block',
      title: 'Known-bad installer',
      description: 'Blocked during IR-2317',
      generateAlert: false,
      severity: 'High',
    })
    expect(result.success).toBe(true)
    expect(result.message).toContain(API_HOST)
  })

  it('records a created indicator as new, with the id Defender assigned, so rollback can delete it', async () => {
    mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item()]))

    const entries = rollbackEntries(result)
    expect(entries).toHaveLength(1)
    expect(entries[0].existed).toBe(false)
    expect(entries[0].id).toBe('ind-new')
    expect(entries[0].prior).toBeUndefined()
  })

  it('matches a live indicator case-insensitively and records its prior state so rollback can restore it', async () => {
    const live = {
      id: 'ind-live',
      indicatorType: 'FileSha256',
      indicatorValue: SHA256.toUpperCase(),
      action: 'Audit',
      severity: 'Low',
      title: 'Watchlisted',
      description: 'Previously audit-only',
      generateAlert: true,
    }
    mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { value: [live] } } : { status: 200, body: { id: 'ind-live' } },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    const entries = rollbackEntries(result)
    expect(entries).toHaveLength(1)
    expect(entries[0].existed).toBe(true)
    expect(entries[0].id).toBe('ind-live')
    expect(entries[0].prior?.action).toBe('Audit')
    expect(entries[0].prior?.severity).toBe('Low')
    expect(result.success).toBe(true)
  })

  it('forces generateAlert on an Audit indicator, which Defender rejects without one', async () => {
    const calls = mockMdeFetch(emptyTenant)
    await deploy(deployCtx(TYPE, [item({ action: 'Audit', generate_alert: false })]))

    const posted = vendorCalls(calls).find((c) => c.method === 'POST')?.body as Record<string, unknown>
    expect(posted.action).toBe('Audit')
    expect(posted.generateAlert).toBe(true)
  })

  it('omits optional fields that were left blank rather than sending empty strings', async () => {
    const calls = mockMdeFetch(emptyTenant)
    await deploy(deployCtx(TYPE, [item()]))

    const posted = vendorCalls(calls).find((c) => c.method === 'POST')?.body as Record<string, unknown>
    expect('expirationTime' in posted).toBe(false)
    expect('application' in posted).toBe(false)
    expect('rbacGroupNames' in posted).toBe(false)
  })

  it('sends the optional fields that were filled in', async () => {
    const calls = mockMdeFetch(emptyTenant)
    await deploy(
      deployCtx(TYPE, [
        item({
          expiration_time: '2030-01-01T00:00:00Z',
          application: 'Contoso IR',
          recommended_actions: 'Isolate the device',
          rbac_group_names: 'Servers, Workstations',
        }),
      ]),
    )

    const posted = vendorCalls(calls).find((c) => c.method === 'POST')?.body as Record<string, unknown>
    expect(posted.expirationTime).toBe('2030-01-01T00:00:00Z')
    expect(posted.application).toBe('Contoso IR')
    expect(posted.recommendedActions).toBe('Isolate the device')
    expect(posted.rbacGroupNames).toEqual(['Servers', 'Workstations'])
  })

  it('returns a FAILED result instead of throwing when Defender rejects the write', async () => {
    mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { value: [] } } : { status: 403, body: apiError('Ti.ReadWrite.All is required') },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Ti.ReadWrite.All is required')
    expect(result.message).toContain('failed after 0 of 1')
  })

  it('writes nothing when the live listing cannot be read', async () => {
    const calls = mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Failed to list indicators')
    // Reconciling without a readable current state would blindly overwrite.
    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('stops at the first rejection and keeps the rollback state for what it already wrote', async () => {
    let posts = 0
    mockMdeFetch((method) => {
      if (method === 'GET') return { status: 200, body: { value: [] } }
      posts += 1
      return posts === 1 ? { status: 201, body: { id: 'ind-1' } } : { status: 400, body: apiError('indicator limit reached') }
    })
    const result = await deploy(
      deployCtx(TYPE, [item({}, 'first'), item({ indicator_type: 'FileSha1', indicator_value: SHA1 }, 'second')]),
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('failed after 1 of 2')
    expect(result.artifacts?.deployed as string[]).toHaveLength(1)
    expect(rollbackEntries(result)).toHaveLength(1)
    expect(rollbackEntries(result)[0].id).toBe('ind-1')
  })

  it('skips canvas items that declare no type or value instead of posting an empty indicator', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [{ name: 'placeholder', fields: {} }, item()]))

    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(result.message).toContain('Deployed 1 indicator(s)')
  })

  it('reuses one access token across every request of a deploy', async () => {
    const calls = mockMdeFetch(emptyTenant)
    await deploy(deployCtx(TYPE, [item({}, 'first'), item({ indicator_type: 'FileSha1', indicator_value: SHA1 }, 'second')]))

    expect(calls.filter((c) => c.url.includes(TOKEN_PATH))).toHaveLength(1)
  })
})
