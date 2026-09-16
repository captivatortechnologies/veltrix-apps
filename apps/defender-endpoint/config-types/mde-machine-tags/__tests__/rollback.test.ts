// =============================================================================
// Rollback handler tests against a FAKE Defender API.
//
// The property that makes this rollback safe to run on a shared device: a tag
// that was ALREADY on the device before the deploy is never removed, because
// removing it would undo someone else's tagging, not ours.
// =============================================================================

import rollback from '../rollback'
import type { MachineTagRollbackEntry } from '../deploy'
import { MACHINE_ID, apiError, mockMdeFetch, rollbackCtx, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-machine-tags'

const added: MachineTagRollbackEntry = {
  key: `${MACHINE_ID}::pci`,
  label: 'pci on dc01.contoso.com',
  machineId: MACHINE_ID,
  tag: 'pci',
  existed: false,
}

const preExisting: MachineTagRollbackEntry = {
  key: `${MACHINE_ID}::crown-jewel`,
  label: 'crown-jewel on dc01.contoso.com',
  machineId: MACHINE_ID,
  tag: 'crown-jewel',
  existed: true,
}

const state = (entries: MachineTagRollbackEntry[]) => ({ previousState: entries })

describe('Defender Machine Tags Rollback Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([added]), { credential: null }))

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

  it('removes a tag this deploy added', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([added])))

    expect(vendorCalls(calls)).toHaveLength(1)
    expect(vendorCalls(calls)[0].url).toContain(`/api/machines/${MACHINE_ID}/tags`)
    expect(vendorCalls(calls)[0].body).toEqual({ Value: 'pci', Action: 'Remove' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('Rolled back 1 device tag(s)')
  })

  it('leaves a tag that was already on the device before the deploy', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([preExisting])))

    expect(vendorCalls(calls)).toHaveLength(0)
    expect(result.success).toBe(true)
    expect(result.message).toContain('Rolled back 1 device tag(s)')
  })

  it('removes only the added tag when the deploy touched both kinds', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    await rollback(rollbackCtx(TYPE, state([preExisting, added])))

    expect(vendorCalls(calls)).toHaveLength(1)
    expect((vendorCalls(calls)[0].body as Record<string, unknown>).Value).toBe('pci')
  })

  it('treats a 404 as a device that has since been offboarded', async () => {
    mockMdeFetch(() => ({ status: 404, body: apiError('ResourceNotFound') }))
    const result = await rollback(rollbackCtx(TYPE, state([added])))

    expect(result.success).toBe(true)
  })

  it('returns a FAILED result instead of throwing when Defender rejects the removal', async () => {
    mockMdeFetch(() => ({ status: 403, body: apiError('insufficient privileges') }))
    const result = await rollback(rollbackCtx(TYPE, state([added])))

    expect(result.success).toBe(false)
    expect(result.message).toContain('insufficient privileges')
    expect(result.message).toContain('Rollback failed after 0 of 1')
  })
})
