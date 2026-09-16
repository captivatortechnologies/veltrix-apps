// =============================================================================
// Rollback handler tests against a FAKE Microsoft Graph.
// =============================================================================

import rollback from '../rollback'
import type { DetectionRuleRollbackEntry } from '../deploy'
import { apiError, mockMdeFetch, rollbackCtx, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-detection-rules'
const RULE_ID = 'office-encoded-powershell'
const OTHER_RULE_ID = 'lsass-credential-access'

const created: DetectionRuleRollbackEntry = {
  key: RULE_ID,
  label: RULE_ID,
  existed: false,
  id: RULE_ID,
}

const updated: DetectionRuleRollbackEntry = {
  key: OTHER_RULE_ID,
  label: OTHER_RULE_ID,
  existed: true,
  id: OTHER_RULE_ID,
  prior: {
    id: OTHER_RULE_ID,
    displayName: 'LSASS credential access (original)',
    status: 'disabled',
    queryCondition: { queryText: 'DeviceEvents | take 1' },
    schedule: { frequency: 'P1D' },
    detectionAction: {
      alertTemplate: { title: 'LSASS access', description: 'Original alert', severity: 'medium', category: 'CredentialAccess' },
    },
  },
}

const state = (entries: DetectionRuleRollbackEntry[]) => ({ previousState: entries })

describe('Defender Detection Rules Rollback Handler', () => {
  it('refuses before touching Graph when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([created]), { credential: null }))

    expect(result.success).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses before touching Graph in a gov cloud', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(
      rollbackCtx(TYPE, state([created]), { settings: { tenant_id: 'tenant', azure_cloud: 'dod' } }),
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('commercial cloud')
    expect(calls).toHaveLength(0)
  })

  it('reports failure without calling Graph when the deploy recorded no previous state', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, {}))

    expect(result.success).toBe(false)
    expect(result.message).toBe('No previous state available for rollback')
    expect(calls).toHaveLength(0)
  })

  it('deletes a rule this deploy created', async () => {
    const calls = mockMdeFetch(() => ({ status: 204, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(vendorCalls(calls)).toHaveLength(1)
    expect(vendorCalls(calls)[0].method).toBe('DELETE')
    expect(vendorCalls(calls)[0].url).toContain(`/security/rules/detectionRules/${RULE_ID}`)
    expect(result.success).toBe(true)
  })

  it('treats a 404 on delete as already gone', async () => {
    mockMdeFetch(() => ({ status: 404, body: apiError('not found') }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(result.success).toBe(true)
  })

  it('restores an updated rule from its captured prior state, never from the canvas', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await rollback(rollbackCtx(TYPE, state([updated])))

    const patch = vendorCalls(calls).find((c) => c.method === 'PATCH')
    expect(patch?.url).toContain(`/security/rules/detectionRules/${OTHER_RULE_ID}`)
    expect(patch?.body).toEqual({
      displayName: 'LSASS credential access (original)',
      queryCondition: { queryText: 'DeviceEvents | take 1' },
      schedule: { frequency: 'P1D' },
      status: 'disabled',
      detectionAction: {
        alertTemplate: { title: 'LSASS access', description: 'Original alert', severity: 'medium', category: 'CredentialAccess' },
      },
    })
    expect(result.success).toBe(true)
  })

  it('never deletes a rule the deploy only updated', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    await rollback(rollbackCtx(TYPE, state([updated])))

    expect(vendorCalls(calls).filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  it('undoes in reverse deploy order', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    await rollback(rollbackCtx(TYPE, state([created, updated])))

    expect(vendorCalls(calls)[0].method).toBe('PATCH')
    expect(vendorCalls(calls)[1].method).toBe('DELETE')
  })

  it('returns a FAILED result instead of throwing when Graph rejects the undo', async () => {
    mockMdeFetch(() => ({ status: 403, body: apiError('insufficient privileges') }))
    const result = await rollback(rollbackCtx(TYPE, state([created])))

    expect(result.success).toBe(false)
    expect(result.message).toContain('insufficient privileges')
    expect(result.message).toContain('Rollback failed after 0 of 1')
  })
})
