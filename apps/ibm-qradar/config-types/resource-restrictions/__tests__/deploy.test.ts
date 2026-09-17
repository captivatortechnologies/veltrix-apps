// deploy for resource-restrictions.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// that a restriction has NO name — its identity is the target it applies to, and
// that target is declared by name and resolved through the tenant and user-role
// lists. Resolve it to the wrong id and the console throttles the wrong tenant's
// analysts; resolve it to nothing and the write must not happen at all. Updates
// go out as PUT, not POST.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  created,
  deployContext,
  item,
  leaksToken,
  list,
  ok,
  pathOf,
  qradarError,
  routeFetch,
  writeCalls,
  type CannedResponse,
  type Route,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const RR = '/config/resource_restrictions'

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

const ANALYST = item('Security Analyst', {
  targetType: 'role',
  targetName: 'Security Analyst',
  recordLimit: 25000,
})

registerDeployGuardContract({ label: 'resource-restrictions', handler: deploy, sampleItems: [ACME] })

interface RouteOverrides {
  tenants?: CannedResponse
  roles?: CannedResponse
  live?: CannedResponse
  create?: CannedResponse
  update?: CannedResponse
  remove?: CannedResponse
}

function routes(over: RouteOverrides = {}): Route[] {
  return [
    { url: /\/tenant_management\/tenants$/, respond: over.tenants ?? list([ACME_TENANT, RETIRED_TENANT]) },
    { url: /\/user_roles$/, respond: over.roles ?? list([ANALYST_ROLE]) },
    { url: /\/resource_restrictions$/, method: 'GET', respond: over.live ?? list([]) },
    { url: /\/resource_restrictions$/, method: 'POST', respond: over.create ?? created({ id: 91 }) },
    { url: /\/resource_restrictions\/\d+$/, method: 'PUT', respond: over.update ?? ok({}) },
    { url: /\/resource_restrictions\/\d+$/, method: 'DELETE', respond: over.remove ?? ACCEPTED },
  ]
}

/** The live restriction already attached to the Acme tenant. */
function liveAcme(over: Record<string, unknown> = {}) {
  return { id: 55, tenant_id: 3, data_window: 86400, execution_time: 600, record_limit: 100000, ...over }
}

function entriesOf(result: { rollbackData?: unknown }): Array<Record<string, unknown>> {
  return (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
}

test('resource-restrictions deploy: the resolved target id lands in tenant_id or role_id by target type', async () => {
  // Sending a role id in `tenant_id` would restrict an unrelated tenant — the
  // two id spaces are separate and both are small integers, so nothing rejects
  // the mistake.
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(deployContext([ACME, ANALYST]))

    assertQRadarHeaders(assert, calls)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.deepEqual(bodyOf(writes[0]), {
      data_window: 604800,
      execution_time: 1200,
      record_limit: 500000,
      tenant_id: 3,
    })
    assert.deepEqual(bodyOf(writes[1]), { record_limit: 25000, role_id: 12 })
    assert.equal(result.success, true)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('resource-restrictions deploy: PUTs a target that already has a restriction and POSTs one that does not', async () => {
  // There is no name to look up: the only way to tell "update" from "create" is
  // whether a live row already carries this target's id. Getting it wrong gives
  // the target two restrictions and no way to tell which one applies.
  const { calls, restore } = routeFetch(routes({ live: list([liveAcme()]) }))
  try {
    const result = await deploy(deployContext([ACME, ANALYST]))

    assert.deepEqual(
      writeCalls(calls).map((c) => `${c.method} ${pathOf(c)}`),
      [`PUT ${RR}/55`, `POST ${RR}`],
      'an existing restriction is updated in place with PUT, a new one is posted to the collection',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('resource-restrictions deploy: records the id as a STRING, for both the update and the create path', async () => {
  // Rollback guards on `if (!e.id) continue` and builds `${PATH}/${e.id}`. A
  // numeric id that round-tripped through the deployment record as a number
  // would still work; one recorded as 0, '' or undefined would silently skip.
  const { restore } = routeFetch(routes({ live: list([liveAcme()]) }))
  try {
    const result = await deploy(deployContext([ACME, ANALYST]))

    const entries = entriesOf(result)
    assert.equal(entries[0].id, '55')
    assert.equal(typeof entries[0].id, 'string')
    assert.equal(entries[0].existed, true)
    assert.equal(entries[1].id, '91')
    assert.equal(typeof entries[1].id, 'string')
    assert.equal(entries[1].existed, false)
  } finally {
    restore()
  }
})

test('resource-restrictions deploy: a target name that resolves to nothing fails the item without writing', async () => {
  // The target id is the only thing identifying the restriction. Writing without
  // one would apply the limits to whatever row the console defaulted to.
  const unknown = item('Ghost Tenant', { targetType: 'tenant', targetName: 'Ghost Tenant', recordLimit: 10 })
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(deployContext([ACME, unknown]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'only the resolvable item may be written')
    assert.equal(bodyOf(writes[0])?.tenant_id, 3)
    assert.equal(result.success, false)
    assert.match(String(result.message), /tenant "Ghost Tenant": target not found/)
    assert.equal(entriesOf(result).length, 1, 'the item that did deploy is still recorded for rollback')
  } finally {
    restore()
  }
})

test('resource-restrictions deploy: a deleted tenant does not resolve, and nothing is written for it', async () => {
  // QRadar keeps deleted tenants in the list with `deleted: true`. Restricting
  // one is meaningless, and its id may already have been reused.
  const retired = item('Retired Tenant', { targetType: 'tenant', targetName: 'Retired Tenant', recordLimit: 10 })
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(deployContext([retired]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /target not found/)
  } finally {
    restore()
  }
})

test('resource-restrictions deploy: updating records the LIVE prior limits, not the desired ones', async () => {
  // Every live value differs from the canvas, so a handler that recorded the
  // canvas as "prior" would produce a rollback that changes nothing.
  const { calls, restore } = routeFetch(routes({ live: list([liveAcme()]) }))
  try {
    const result = await deploy(deployContext([ACME]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), {
      data_window: 604800,
      execution_time: 1200,
      record_limit: 500000,
      tenant_id: 3,
    })
    assert.deepEqual(entriesOf(result)[0].prior, {
      dataWindow: 86400,
      executionTime: 600,
      recordLimit: 100000,
    })
  } finally {
    restore()
  }
})

test('resource-restrictions deploy: writes nothing when the live limits already match, but still records rollback', async () => {
  const matching = liveAcme({ data_window: 604800, execution_time: 1200, record_limit: 500000 })
  const { calls, restore } = routeFetch(routes({ live: list([matching]) }))
  try {
    const result = await deploy(deployContext([ACME]))

    assert.equal(writeCalls(calls).length, 0, 'an identical restriction must not be rewritten')
    const entries = entriesOf(result)
    assert.equal(entries.length, 1, 'a skipped write still needs a rollback entry')
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, '55')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('resource-restrictions deploy: a rejected update is a failed result, not a thrown error', async () => {
  const { restore } = routeFetch(
    routes({ live: list([liveAcme()]), update: qradarError(422, 'Data window exceeds the retention period') }),
  )
  try {
    const result = await deploy(deployContext([ACME]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /tenant "Acme Corp": Data window exceeds the retention period/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('resource-restrictions deploy: removes a restriction it created before and no longer declares', async () => {
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(
      deployContext([ACME], {
        priorRollbackData: {
          entries: [
            { targetType: 'role', targetName: 'Auditor', targetKey: 'role:auditor', existed: false, id: '88' },
            { targetType: 'role', targetName: 'Admin', targetKey: 'role:admin', existed: true, id: '89' },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${RR}/88`])
    assert.equal(
      deletes.includes(`${RR}/89`),
      false,
      'a restriction that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('resource-restrictions deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})
