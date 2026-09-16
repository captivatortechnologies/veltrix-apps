// =============================================================================
// Rollback handler tests against a FAKE Defender API.
//
// Rollback is the handler that runs when a deploy has already changed a
// customer's tenant, so its failure modes matter more than deploy's: undoing
// the wrong thing, or reporting success after undoing nothing.
// =============================================================================

import rollback from '../rollback'
import type { IndicatorRollbackEntry } from '../../../lib/indicators'
import { apiError, mockMdeFetch, rollbackCtx, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-file-indicators'
const SHA256 = 'a'.repeat(64)
const OTHER_SHA256 = 'e'.repeat(64)

const created: IndicatorRollbackEntry = {
  key: JSON.stringify(['filesha256', SHA256]),
  label: `FileSha256 ${SHA256}`,
  existed: false,
  id: 'ind-new',
}

const updated: IndicatorRollbackEntry = {
  key: JSON.stringify(['filesha256', OTHER_SHA256]),
  label: `FileSha256 ${OTHER_SHA256}`,
  existed: true,
  id: 'ind-live',
  prior: {
    id: 'ind-live',
    indicatorType: 'FileSha256',
    indicatorValue: OTHER_SHA256,
    action: 'Audit',
    severity: 'Low',
    title: 'Watchlisted',
    description: 'Previously audit-only',
    generateAlert: true,
    recommendedActions: 'Review the alert',
    rbacGroupNames: ['Servers'],
  },
}

const state = (entries: IndicatorRollbackEntry[]) => ({ previousState: entries })

describe('Defender File Indicators Rollback Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([created]), { credential: null }))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Client ID')
    expect(calls).toHaveLength(0)
  })

  it('reports failure without calling Defender when the deploy recorded no previous state', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, {}))

    expect(result.success).toBe(false)
    expect(result.message).toBe('No previous state available for rollback')
    expect(calls).toHaveLength(0)
  })

  it('reports failure for an empty previous state rather than claiming a clean rollback', async () => {
    const result = await rollback(rollbackCtx(TYPE, state([])))

    expect(result.success).toBe(false)
    expect(result.message).toBe('No previous state available for rollback')
  })

  it('deletes an indicator this deploy created', async () => {
    const calls = mockMdeFetch(() => ({ status: 204, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    const vendor = vendorCalls(calls)
    expect(vendor).toHaveLength(1)
    expect(vendor[0].method).toBe('DELETE')
    expect(vendor[0].url).toContain('/api/indicators/ind-new')
    expect(result.success).toBe(true)
    expect(result.message).toContain('Rolled back 1 indicator(s)')
  })

  it('treats a 404 on delete as already gone', async () => {
    mockMdeFetch(() => ({ status: 404, body: apiError('not found') }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(result.success).toBe(true)
  })

  it('restores a pre-existing indicator from its captured prior state, not from the canvas', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: { id: 'ind-live' } }))
    const result = await rollback(rollbackCtx(TYPE, state([updated])))

    const vendor = vendorCalls(calls)
    expect(vendor).toHaveLength(1)
    expect(vendor[0].method).toBe('POST')
    expect(vendor[0].body).toEqual({
      indicatorValue: OTHER_SHA256,
      indicatorType: 'FileSha256',
      action: 'Audit',
      title: 'Watchlisted',
      description: 'Previously audit-only',
      generateAlert: true,
      severity: 'Low',
      recommendedActions: 'Review the alert',
      rbacGroupNames: ['Servers'],
    })
    expect(result.success).toBe(true)
  })

  it('never deletes an indicator the deploy only updated', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    await rollback(rollbackCtx(TYPE, state([updated])))

    expect(vendorCalls(calls).filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  it('undoes in reverse deploy order, so the last change made is the first undone', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    await rollback(rollbackCtx(TYPE, state([created, updated])))

    const vendor = vendorCalls(calls)
    expect(vendor[0].method).toBe('POST')
    expect(vendor[1].method).toBe('DELETE')
  })

  it('returns a FAILED result instead of throwing when Defender rejects the undo', async () => {
    mockMdeFetch(() => ({ status: 403, body: apiError('insufficient privileges') }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(result.success).toBe(false)
    expect(result.message).toContain('insufficient privileges')
    expect(result.message).toContain('Rollback failed after 0 of 1')
  })

  it('reports how far it got when a later undo is rejected', async () => {
    let seen = 0
    mockMdeFetch(() => {
      seen += 1
      return seen === 1 ? { status: 200, body: {} } : { status: 500, body: apiError('boom') }
    })
    const result = await rollback(rollbackCtx(TYPE, state([created, updated])))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Rollback failed after 1 of 2')
  })

  it('skips a created entry whose id the deploy never learned, rather than deleting blindly', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([{ ...created, id: undefined }])))

    expect(vendorCalls(calls)).toHaveLength(0)
    expect(result.success).toBe(true)
  })
})
