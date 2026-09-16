// =============================================================================
// Rollback handler tests against a FAKE Defender API.
//
// Two things distinguish this rollback: Defender has no single-item DELETE for
// a scan definition (only a batch endpoint), and the restore PATCH must OMIT
// scanAuthenticationParams — omitting it leaves the live credential alone,
// whereas sending an empty one would wipe it.
// =============================================================================

import rollback from '../rollback'
import type { ScanDefinitionRollbackEntry } from '../deploy'
import { MACHINE_ID, apiError, mockMdeFetch, rollbackCtx, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-scan-definitions'
const SCAN_PATH = '/api/DeviceAuthenticatedScanDefinitions'

const created: ScanDefinitionRollbackEntry = {
  key: 'datacenter switches',
  scanName: 'Datacenter switches',
  id: 'scan-new',
  existed: false,
}

const updated: ScanDefinitionRollbackEntry = {
  key: 'edge routers',
  scanName: 'Edge routers',
  id: 'scan-live',
  existed: true,
  prior: {
    scanName: 'Edge routers',
    isActive: false,
    target: '10.9.9.9',
    targetType: 'Hostname',
    intervalInHours: 12,
    scannerMachineId: MACHINE_ID,
  },
}

const state = (entries: ScanDefinitionRollbackEntry[]) => ({ previousState: entries })

describe('Defender Scan Definitions Rollback Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([created]), { credential: null }))

    expect(result.success).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reports failure without calling Defender when the deploy recorded no previous state', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, {}))

    expect(result.success).toBe(false)
    expect(result.message).toBe('No previous state available for rollback')
    expect(calls).toHaveLength(0)
  })

  it('deletes a definition this deploy created through the batch endpoint', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(vendorCalls(calls)).toHaveLength(1)
    expect(vendorCalls(calls)[0].method).toBe('POST')
    expect(vendorCalls(calls)[0].url).toContain(`${SCAN_PATH}/BatchDelete`)
    expect(vendorCalls(calls)[0].body).toEqual({ ScanDefinitionIds: ['scan-new'] })
    expect(result.success).toBe(true)
  })

  it('restores an updated definition from its captured non-secret fields', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([updated])))

    const patch = vendorCalls(calls).find((c) => c.method === 'PATCH')
    expect(patch?.url).toContain(`${SCAN_PATH}/scan-live`)
    expect(patch?.body).toEqual({
      scanType: 'Network',
      scanName: 'Edge routers',
      isActive: false,
      target: '10.9.9.9',
      targetType: 'Hostname',
      intervalInHours: 12,
      scannerAgent: { machineId: MACHINE_ID },
    })
    expect(result.success).toBe(true)
  })

  it('omits scanAuthenticationParams from the restore, so the live credential is left untouched', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    await rollback(rollbackCtx(TYPE, state([updated])))

    const body = vendorCalls(calls).find((c) => c.method === 'PATCH')?.body as Record<string, unknown>
    expect('scanAuthenticationParams' in body).toBe(false)
  })

  it('says plainly that a credential change could not be undone', async () => {
    mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([updated])))

    expect(result.message).toContain('that credential could not be restored')
  })

  it('adds no credential caveat when nothing was updated', async () => {
    mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(result.message).toBe('Rolled back 1 scan definition(s)')
  })

  it('undoes in reverse deploy order', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    await rollback(rollbackCtx(TYPE, state([created, updated])))

    expect(vendorCalls(calls)[0].method).toBe('PATCH')
    expect(vendorCalls(calls)[1].url).toContain('BatchDelete')
  })

  it('returns a FAILED result instead of throwing when the batch delete is rejected', async () => {
    mockMdeFetch(() => ({ status: 403, body: apiError('insufficient privileges') }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(result.success).toBe(false)
    expect(result.message).toContain('insufficient privileges')
    expect(result.message).toContain('Rollback failed after 0 of 1')
  })

  it('reports how far it got when a later restore is rejected', async () => {
    let seen = 0
    mockMdeFetch(() => {
      seen += 1
      return seen === 1 ? { status: 200, body: {} } : { status: 500, body: apiError('boom') }
    })
    const result = await rollback(rollbackCtx(TYPE, state([created, updated])))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Rollback failed after 1 of 2')
  })
})
