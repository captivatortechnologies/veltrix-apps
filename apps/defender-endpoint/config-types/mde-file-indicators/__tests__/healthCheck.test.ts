// =============================================================================
// Health-check handler tests against a FAKE Defender API.
//
// Health is what the platform scores a deployment on, so "cannot reach the API"
// must read as unhealthy — never as a pass with nothing checked.
// =============================================================================

import healthCheck from '../healthCheck'
import type { CanvasItemSnapshot, HealthCheck } from '@veltrixsecops/app-sdk'
import { API_HOST, apiError, healthCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

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

const liveSha256 = { id: 'ind-1', indicatorType: 'FileSha256', indicatorValue: SHA256 }
const listing = (indicators: unknown[]) => () => ({ status: 200, body: { value: indicators } })
const named = (checks: HealthCheck[], name: string): HealthCheck | undefined => checks.find((c) => c.name === name)

describe('Defender File Indicators Health Handler', () => {
  it('fails closed without calling Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(listing([]))
    const result = await healthCheck(healthCtx(TYPE, [item()], { credential: null }))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('mde_credential')
    expect(calls).toHaveLength(0)
  })

  it('scores 100 when the API is reachable and every declared indicator is present', async () => {
    mockMdeFetch(listing([liveSha256]))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(named(result.checks, 'mde_reachable')?.message).toContain(API_HOST)
    expect(named(result.checks, `indicator:FileSha256 ${SHA256}`)?.passed).toBe(true)
  })

  it('fails the check for an indicator that is no longer present, and drops the score', async () => {
    mockMdeFetch(listing([liveSha256]))
    const result = await healthCheck(
      healthCtx(TYPE, [item(), item({ indicator_type: 'FileSha1', indicator_value: SHA1 }, 'second')]),
    )

    expect(result.healthy).toBe(false)
    expect(named(result.checks, `indicator:FileSha1 ${SHA1}`)?.passed).toBe(false)
    expect(named(result.checks, `indicator:FileSha1 ${SHA1}`)?.message).toBe('Indicator is missing')
    expect(result.score).toBe(67)
  })

  it('reports unreachable rather than throwing, and claims no per-indicator result it could not check', async () => {
    mockMdeFetch(() => ({ status: 503, body: apiError('service unavailable') }))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(named(result.checks, 'mde_reachable')?.passed).toBe(false)
  })

  it('matches a live indicator case-insensitively', async () => {
    mockMdeFetch(listing([{ ...liveSha256, indicatorValue: SHA256.toUpperCase() }]))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(true)
  })
})
