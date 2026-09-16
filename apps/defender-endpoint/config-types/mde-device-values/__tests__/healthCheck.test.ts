// =============================================================================
// Health-check handler tests against a FAKE Defender API.
//
// The machines API answers 404 for "nothing matched", so a 404 on the probe
// still means the API is up — the check has to tell that apart from a real
// outage, or every empty tenant would look unhealthy.
// =============================================================================

import healthCheck from '../healthCheck'
import type { CanvasItemSnapshot, HealthCheck } from '@veltrixsecops/app-sdk'
import { API_HOST, MACHINE_ID, apiError, healthCtx, mockMdeFetch, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-device-values'

/** The reachability probe is the only GET that carries a $top query. */
const isProbe = (url: string): boolean => url.includes('%24top')

function item(fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: 'Domain controller',
    fields: { device_type: 'id', device: MACHINE_ID, criticality: 'High', ...fields },
  }
}

const named = (checks: HealthCheck[], name: string): HealthCheck | undefined => checks.find((c) => c.name === name)

describe('Defender Device Values Health Handler', () => {
  it('fails closed without calling Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await healthCheck(healthCtx(TYPE, [item()], { credential: null }))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks[0].name).toBe('mde_credential')
    expect(calls).toHaveLength(0)
  })

  it('scores 100 when the API is reachable and the device carries the declared criticality', async () => {
    mockMdeFetch((_method, url) =>
      isProbe(url)
        ? { status: 200, body: { value: [] } }
        : { status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', deviceValue: 'High' } },
    )
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(named(result.checks, 'mde_reachable')?.message).toContain(API_HOST)
    expect(named(result.checks, 'value:High on dc01.contoso.com')?.passed).toBe(true)
  })

  it('treats a 404 from the probe as reachable, not as an outage', async () => {
    mockMdeFetch((_method, url) =>
      isProbe(url)
        ? { status: 404, body: apiError('ResourceNotFound') }
        : { status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', deviceValue: 'High' } },
    )
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(named(result.checks, 'mde_reachable')?.passed).toBe(true)
    expect(result.healthy).toBe(true)
  })

  it('fails the device check when the criticality was changed by hand', async () => {
    mockMdeFetch((_method, url) =>
      isProbe(url)
        ? { status: 200, body: { value: [] } }
        : { status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', deviceValue: 'Low' } },
    )
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(named(result.checks, 'value:High on dc01.contoso.com')?.passed).toBe(false)
    expect(named(result.checks, 'value:High on dc01.contoso.com')?.message).toContain('Device value is Low')
  })

  it('fails the device check when the device is gone', async () => {
    mockMdeFetch((_method, url) =>
      isProbe(url) ? { status: 200, body: { value: [] } } : { status: 404, body: apiError('ResourceNotFound') },
    )
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(named(result.checks, `device:${MACHINE_ID}`)?.passed).toBe(false)
    expect(named(result.checks, `device:${MACHINE_ID}`)?.message).toBe('Device not found')
  })

  it('reports an outage without probing any device', async () => {
    const calls = mockMdeFetch(() => ({ status: 503, body: apiError('service unavailable') }))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(named(result.checks, 'mde_reachable')?.message).toContain('HTTP 503')
    expect(vendorCalls(calls)).toHaveLength(1)
  })
})
