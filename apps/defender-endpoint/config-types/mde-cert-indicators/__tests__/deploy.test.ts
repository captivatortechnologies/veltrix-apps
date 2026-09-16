// =============================================================================
// Deploy handler tests against a FAKE Defender API.
//
// This config type is a thin wrapper over the shared indicator implementation
// (lib/indicators.ts, fully covered under mde-file-indicators). These tests pin
// the wiring and the certificate-thumbprint values it has to carry intact.
// =============================================================================

import deploy from '../deploy'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { IndicatorRollbackEntry } from '../../../lib/indicators'
import { apiError, deployCtx, mockMdeFetch, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-cert-indicators'
const THUMBPRINT = 'ab'.repeat(20)

function item(fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: 'Revoked signing certificate',
    fields: {
      indicator_type: 'CertificateThumbprint',
      indicator_value: THUMBPRINT,
      action: 'Block',
      severity: 'High',
      title: 'Revoked signing certificate',
      description: 'Stolen code-signing cert from IR-2317',
      ...fields,
    },
  }
}

const emptyTenant = (method: string) =>
  method === 'GET' ? { status: 200, body: { value: [] } } : { status: 201, body: { id: 'ind-new' } }

const rollbackEntries = (result: { rollbackData?: unknown }): IndicatorRollbackEntry[] =>
  (result.rollbackData as { previousState?: IndicatorRollbackEntry[] })?.previousState ?? []

describe('Defender Certificate Indicators Deploy Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item()], { credential: null }))

    expect(result.success).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('creates a thumbprint indicator that does not exist yet', async () => {
    const calls = mockMdeFetch(emptyTenant)
    const result = await deploy(deployCtx(TYPE, [item()]))

    const post = vendorCalls(calls).find((c) => c.method === 'POST')
    expect(post?.url).toContain('/api/indicators')
    expect((post?.body as Record<string, unknown>).indicatorType).toBe('CertificateThumbprint')
    expect((post?.body as Record<string, unknown>).indicatorValue).toBe(THUMBPRINT)
    expect(rollbackEntries(result)[0].existed).toBe(false)
    expect(rollbackEntries(result)[0].id).toBe('ind-new')
    expect(result.success).toBe(true)
  })

  it('records a pre-existing thumbprint as an update so rollback restores rather than deletes it', async () => {
    const live = {
      id: 'ind-live',
      indicatorType: 'CertificateThumbprint',
      indicatorValue: THUMBPRINT.toUpperCase(),
      action: 'Audit',
      severity: 'Medium',
    }
    mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { value: [live] } } : { status: 200, body: { id: 'ind-live' } },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(rollbackEntries(result)[0].existed).toBe(true)
    expect(rollbackEntries(result)[0].id).toBe('ind-live')
    expect(rollbackEntries(result)[0].prior?.action).toBe('Audit')
  })

  it('returns a FAILED result instead of throwing when Defender rejects the write', async () => {
    mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { value: [] } } : { status: 403, body: apiError('Ti.ReadWrite.All is required') },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Ti.ReadWrite.All is required')
  })

  it('writes nothing when the live listing cannot be read', async () => {
    const calls = mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(vendorCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(0)
  })
})
