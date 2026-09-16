// =============================================================================
// Drift-detection handler tests against a FAKE Defender API.
//
// Drift compares only the non-secret fields. A credential-only change on the
// live side is invisible here BY DESIGN — Microsoft's own docs disagree about
// whether the credential is ever readable back, so this app never trusts a live
// value for it.
// =============================================================================

import driftDetect from '../driftDetect'
import type { CanvasItemSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import { MACHINE_ID, apiError, driftCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-scan-definitions'
const SCAN_NAME = 'Datacenter switches'
const COMMUNITY_STRING = 'super-secret-community'

function item(fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: SCAN_NAME,
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

function live(extra: Record<string, unknown> = {}) {
  return {
    id: 'scan-live',
    scanName: SCAN_NAME,
    isActive: true,
    target: '10.0.0.1,10.0.0.2',
    targetType: 'Ip',
    intervalInHours: 24,
    ...extra,
  }
}

const listing = (definitions: unknown[]) => () => ({ status: 200, body: { value: definitions } })
const find = (diffs: DriftDiff[], field: string): DriftDiff | undefined => diffs.find((d) => d.field === field)

describe('Defender Scan Definitions Drift Handler', () => {
  it('makes no call and raises no diff when no credential is configured', async () => {
    const calls = mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, [item()], { credential: null }))

    expect(result.hasDrift).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reports no drift when every non-secret field still matches', async () => {
    mockMdeFetch(listing([live()]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('reports a deleted definition as critical drift', async () => {
    mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, SCAN_NAME)?.expected).toBe('exists')
    expect(find(result.diffs, SCAN_NAME)?.severity).toBe('critical')
  })

  it('reports a scan that was switched off as a warning', async () => {
    mockMdeFetch(listing([live({ isActive: false })]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, `${SCAN_NAME}.isActive`)?.expected).toBe(true)
    expect(find(result.diffs, `${SCAN_NAME}.isActive`)?.actual).toBe(false)
    expect(find(result.diffs, `${SCAN_NAME}.isActive`)?.severity).toBe('warning')
  })

  it('reports edited targets, target type and interval', async () => {
    mockMdeFetch(listing([live({ target: '10.0.0.1', targetType: 'Hostname', intervalInHours: 6 })]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, `${SCAN_NAME}.target`)?.expected).toBe('10.0.0.1,10.0.0.2')
    expect(find(result.diffs, `${SCAN_NAME}.target`)?.actual).toBe('10.0.0.1')
    expect(find(result.diffs, `${SCAN_NAME}.targetType`)?.actual).toBe('Hostname')
    expect(find(result.diffs, `${SCAN_NAME}.intervalInHours`)?.actual).toBe(6)
  })

  it('never diffs the SNMP credential, and never leaks it into a diff', async () => {
    mockMdeFetch(listing([live({ isActive: false, scanAuthenticationParams: { type: 'CommunityString', CommunityString: 'rotated' } })]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe(`${SCAN_NAME}.isActive`)
    expect(JSON.stringify(result.diffs).includes(COMMUNITY_STRING)).toBe(false)
    expect(JSON.stringify(result.diffs).includes('scanAuthenticationParams')).toBe(false)
  })

  it('matches the live definition by scan name case-insensitively', async () => {
    mockMdeFetch(listing([live({ scanName: SCAN_NAME.toUpperCase() })]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
  })

  it('reports the API as unreachable instead of throwing when the listing fails', async () => {
    mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(true)
    expect(find(result.diffs, 'mde')?.severity).toBe('critical')
  })

  it('ignores definitions it never declared, which the portal may own', async () => {
    mockMdeFetch(listing([live(), { id: 'other', scanName: 'Someone elses scan', isActive: false }]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
  })
})
