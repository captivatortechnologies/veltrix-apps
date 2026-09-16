// =============================================================================
// Health-check handler tests against a FAKE Defender API.
//
// A scan definition is only useful if its scanner agent still exists, so health
// checks the definition AND the device separately — a decommissioned scanner is
// a silent failure otherwise.
// =============================================================================

import healthCheck from '../healthCheck'
import type { CanvasItemSnapshot, HealthCheck } from '@veltrixsecops/app-sdk'
import { API_HOST, MACHINE_ID, apiError, healthCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-scan-definitions'
const SCAN_NAME = 'Datacenter switches'
const SCAN_PATH = '/api/DeviceAuthenticatedScanDefinitions'

const isScanList = (url: string): boolean => url.includes(SCAN_PATH)

function item(fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: SCAN_NAME,
    fields: {
      scan_name: SCAN_NAME,
      is_active: true,
      interval_hours: 24,
      target_type: 'Ip',
      target: '10.0.0.1',
      scanner_agent_device_type: 'id',
      scanner_agent_device: MACHINE_ID,
      auth_mode: 'CommunityString',
      community_string: 'secret',
      ...fields,
    },
  }
}

const liveDefinition = { id: 'scan-live', scanName: SCAN_NAME, isActive: true }
const named = (checks: HealthCheck[], name: string): HealthCheck | undefined => checks.find((c) => c.name === name)

describe('Defender Scan Definitions Health Handler', () => {
  it('fails closed without calling Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await healthCheck(healthCtx(TYPE, [item()], { credential: null }))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks[0].name).toBe('mde_credential')
    expect(calls).toHaveLength(0)
  })

  it('scores 100 when the definition exists and its scanner device still resolves', async () => {
    mockMdeFetch((_method, url) =>
      isScanList(url) ? { status: 200, body: { value: [liveDefinition] } } : { status: 200, body: { id: MACHINE_ID } },
    )
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(named(result.checks, 'mde_reachable')?.message).toContain(API_HOST)
    expect(named(result.checks, `scan:${SCAN_NAME}`)?.passed).toBe(true)
    expect(named(result.checks, `scanner-device:${SCAN_NAME}`)?.passed).toBe(true)
  })

  it('fails the definition check when the scan has been deleted', async () => {
    mockMdeFetch((_method, url) =>
      isScanList(url) ? { status: 200, body: { value: [] } } : { status: 200, body: { id: MACHINE_ID } },
    )
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(named(result.checks, `scan:${SCAN_NAME}`)?.passed).toBe(false)
    expect(named(result.checks, `scan:${SCAN_NAME}`)?.message).toBe('Scan definition is missing')
  })

  it('fails the scanner check when the scanner device has been decommissioned', async () => {
    mockMdeFetch((_method, url) =>
      isScanList(url)
        ? { status: 200, body: { value: [liveDefinition] } }
        : { status: 404, body: apiError('ResourceNotFound') },
    )
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(named(result.checks, `scan:${SCAN_NAME}`)?.passed).toBe(true)
    expect(named(result.checks, `scanner-device:${SCAN_NAME}`)?.passed).toBe(false)
    expect(named(result.checks, `scanner-device:${SCAN_NAME}`)?.message).toContain('not found')
    expect(result.score).toBe(67)
  })

  it('reports unreachable rather than throwing, and claims no per-scan result it could not check', async () => {
    mockMdeFetch(() => ({ status: 503, body: apiError('service unavailable') }))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(named(result.checks, 'mde_reachable')?.passed).toBe(false)
  })
})
