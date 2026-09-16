// =============================================================================
// Rollback handler tests against a FAKE Defender API.
//
// Defender exposes no "download library file content" endpoint, so a file this
// deploy OVERWROTE cannot have its prior bytes restored. The behaviour under
// test is that the handler says so by name instead of reporting a clean undo.
// =============================================================================

import rollback from '../rollback'
import type { LibraryFileRollbackEntry } from '../deploy'
import { apiError, mockMdeFetch, rollbackCtx, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-live-response-library'

const created: LibraryFileRollbackEntry = { key: 'get-logs.ps1', fileName: 'Get-Logs.ps1', existed: false }
const overwritten: LibraryFileRollbackEntry = { key: 'triage.ps1', fileName: 'Triage.ps1', existed: true }

const state = (entries: LibraryFileRollbackEntry[]) => ({ previousState: entries })

describe('Defender Live Response Library Rollback Handler', () => {
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

  it('deletes a file this deploy created', async () => {
    const calls = mockMdeFetch(() => ({ status: 204, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(vendorCalls(calls)).toHaveLength(1)
    expect(vendorCalls(calls)[0].method).toBe('DELETE')
    expect(vendorCalls(calls)[0].url).toContain('/api/libraryfiles/Get-Logs.ps1')
    expect(result.success).toBe(true)
    expect(result.message).toContain('Rolled back 1 created library file(s)')
  })

  it('url-encodes a file name that contains a space', async () => {
    const calls = mockMdeFetch(() => ({ status: 204, body: {} }))
    await rollback(rollbackCtx(TYPE, state([{ key: 'my script.ps1', fileName: 'My Script.ps1', existed: false }])))

    expect(vendorCalls(calls)[0].url).toContain('/api/libraryfiles/My%20Script.ps1')
  })

  it('treats a 404 on delete as already gone', async () => {
    mockMdeFetch(() => ({ status: 404, body: apiError('not found') }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(result.success).toBe(true)
  })

  it('leaves an overwritten file alone and names it as unrestorable rather than claiming a clean undo', async () => {
    const calls = mockMdeFetch(() => ({ status: 204, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([overwritten])))

    expect(vendorCalls(calls)).toHaveLength(0)
    expect(result.success).toBe(true)
    expect(result.message).toContain('Rolled back 0 created library file(s)')
    expect(result.message).toContain('could not have their original content restored')
    expect(result.message).toContain('Triage.ps1')
  })

  it('deletes the created file and still reports the overwritten one it could not restore', async () => {
    const calls = mockMdeFetch(() => ({ status: 204, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([overwritten, created])))

    expect(vendorCalls(calls)).toHaveLength(1)
    expect(vendorCalls(calls)[0].url).toContain('Get-Logs.ps1')
    expect(result.message).toContain('Rolled back 1 created library file(s)')
    expect(result.message).toContain('Triage.ps1')
  })

  it('returns a FAILED result instead of throwing when the delete is rejected', async () => {
    mockMdeFetch(() => ({ status: 403, body: apiError('Library.Manage is required') }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Library.Manage is required')
    expect(result.message).toContain('Rollback failed after 0 of 1')
  })
})
