// driftDetect for resource-restrictions.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: the comparison needs the target NAME resolved to an id before
// it can find the live row at all, so "I could not resolve the target" and "the
// restriction is gone from the console" are different findings. Reporting the
// first as the second would tell an operator their tenant is unrestricted when
// in fact the tenant was merely renamed.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  driftContext,
  item,
  list,
  routeFetch,
  writeCalls,
  type CannedResponse,
  type Route,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const ACME_TENANT = { id: 3, name: 'Acme Corp' }
const RETIRED_TENANT = { id: 4, name: 'Retired Tenant', deleted: true }
const ANALYST_ROLE = { id: 12, name: 'Security Analyst' }

const ACME = item('Acme Corp', {
  targetType: 'tenant',
  targetName: 'Acme Corp',
  dataWindow: 604800,
  executionTime: 1200,
  recordLimit: 500000,
})

registerDriftGuardContract({ label: 'resource-restrictions', handler: driftDetect, sampleItems: [ACME] })

function routes(over: { tenants?: CannedResponse; roles?: CannedResponse; live?: CannedResponse } = {}): Route[] {
  return [
    { url: /\/tenant_management\/tenants$/, respond: over.tenants ?? list([ACME_TENANT, RETIRED_TENANT]) },
    { url: /\/user_roles$/, respond: over.roles ?? list([ANALYST_ROLE]) },
    { url: /\/resource_restrictions$/, method: 'GET', respond: over.live ?? list([]) },
  ]
}

function liveAcme(over: Record<string, unknown> = {}) {
  return { id: 55, tenant_id: 3, data_window: 604800, execution_time: 1200, record_limit: 500000, ...over }
}

test('resource-restrictions driftDetect: reports in sync when the live restriction matches', async () => {
  const { calls, restore } = routeFetch(routes({ live: list([liveAcme()]) }))
  try {
    const result = await driftDetect(driftContext([ACME]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('resource-restrictions driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`; reading it would emit a
  // diff for a target that was never deployed.
  const { restore } = routeFetch(routes({ live: list([liveAcme()]) }))
  try {
    const result = await driftDetect(driftContext([ACME]))

    assert.equal(
      result.diffs.some((d) => String(d.field).includes('canvas-only-item')),
      false,
    )
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('resource-restrictions driftDetect: an unresolvable target is reported as unresolvable, not as absent', async () => {
  // This is the distinction that matters: a renamed or deleted tenant means the
  // run could not locate the row, NOT that the console has stopped restricting
  // anyone. Reporting `absent`/`critical` here would send someone to fix a
  // restriction that is very likely still in force.
  const { restore } = routeFetch(routes({ tenants: list([{ id: 9, name: 'Some Other Tenant' }]) }))
  try {
    const result = await driftDetect(driftContext([ACME]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'tenant/Acme Corp', expected: 'target resolvable', actual: 'target not found', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('resource-restrictions driftDetect: a deleted tenant is unresolvable rather than absent', async () => {
  const retired = item('Retired Tenant', { targetType: 'tenant', targetName: 'Retired Tenant', recordLimit: 10 })
  const { restore } = routeFetch(routes())
  try {
    const result = await driftDetect(driftContext([retired]))

    assert.deepEqual(result.diffs, [
      { field: 'tenant/Retired Tenant', expected: 'target resolvable', actual: 'target not found', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('resource-restrictions driftDetect: reports a resolvable target with no live restriction as critical', async () => {
  const { restore } = routeFetch(routes({ live: list([{ id: 70, role_id: 12, record_limit: 1 }]) }))
  try {
    const result = await driftDetect(driftContext([ACME]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'tenant/Acme Corp', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, 'the list read answered, so the run did check')
  } finally {
    restore()
  }
})

test('resource-restrictions driftDetect: reports limits widened in the console', async () => {
  const { restore } = routeFetch(
    routes({ live: list([liveAcme({ data_window: 86400, record_limit: 100000 })]) }),
  )
  try {
    const result = await driftDetect(driftContext([ACME]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'tenant/Acme Corp.dataWindow', expected: '604800', actual: '86400', severity: 'warning' },
      { field: 'tenant/Acme Corp.recordLimit', expected: '500000', actual: '100000', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('resource-restrictions driftDetect: matches a role target against its own id space', async () => {
  // Tenant 3 and role 12 both have live rows; a handler that keyed only on the
  // numeric id would match the wrong one.
  const analyst = item('Security Analyst', { targetType: 'role', targetName: 'Security Analyst', recordLimit: 25000 })
  const { restore } = routeFetch(
    routes({ live: list([liveAcme(), { id: 70, role_id: 12, record_limit: 25000 }]) }),
  )
  try {
    const result = await driftDetect(driftContext([analyst]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('resource-restrictions driftDetect: an empty deployed config compares nothing and reports in sync', async () => {
  const { calls, restore } = routeFetch(routes({ live: list([liveAcme()]) }))
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined)
  } finally {
    restore()
  }
})
