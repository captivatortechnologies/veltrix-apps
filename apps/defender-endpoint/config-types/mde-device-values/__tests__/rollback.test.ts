// =============================================================================
// Rollback handler tests against a FAKE Defender API.
//
// Rollback here only ever touches the devices the deploy recorded as CHANGED —
// a device the deploy left alone was never recorded, so it can never be written
// back to a value it did not have.
// =============================================================================

import rollback from '../rollback'
import type { DeviceValueRollbackEntry } from '../deploy'
import { MACHINE_ID, apiError, mockMdeFetch, rollbackCtx, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-device-values'
const OTHER_MACHINE_ID = 'e'.repeat(40)

const first: DeviceValueRollbackEntry = {
  key: MACHINE_ID,
  label: 'High on dc01.contoso.com',
  machineId: MACHINE_ID,
  previousValue: 'Normal',
  existed: true,
}

const second: DeviceValueRollbackEntry = {
  key: OTHER_MACHINE_ID,
  label: 'High on dc02.contoso.com',
  machineId: OTHER_MACHINE_ID,
  previousValue: 'Low',
  existed: true,
}

const state = (entries: DeviceValueRollbackEntry[]) => ({ previousState: entries })

describe('Defender Device Values Rollback Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([first]), { credential: null }))

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

  it('restores each recorded device to the criticality it carried before the deploy', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([first])))

    expect(vendorCalls(calls)).toHaveLength(1)
    expect(vendorCalls(calls)[0].method).toBe('PATCH')
    expect(vendorCalls(calls)[0].url).toContain(`/api/machines/${MACHINE_ID}`)
    expect(vendorCalls(calls)[0].body).toEqual({ deviceValue: 'Normal' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('Rolled back 1 device value(s)')
  })

  it('undoes in reverse deploy order', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    await rollback(rollbackCtx(TYPE, state([first, second])))

    expect(vendorCalls(calls)[0].url).toContain(OTHER_MACHINE_ID)
    expect(vendorCalls(calls)[0].body).toEqual({ deviceValue: 'Low' })
    expect(vendorCalls(calls)[1].url).toContain(MACHINE_ID)
  })

  it('treats a 404 as a device that has since been offboarded', async () => {
    mockMdeFetch(() => ({ status: 404, body: apiError('ResourceNotFound') }))
    const result = await rollback(rollbackCtx(TYPE, state([first])))

    expect(result.success).toBe(true)
  })

  it('returns a FAILED result instead of throwing when Defender rejects the restore', async () => {
    mockMdeFetch(() => ({ status: 403, body: apiError('insufficient privileges') }))
    const result = await rollback(rollbackCtx(TYPE, state([first])))

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
    const result = await rollback(rollbackCtx(TYPE, state([first, second])))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Rollback failed after 1 of 2')
  })
})
