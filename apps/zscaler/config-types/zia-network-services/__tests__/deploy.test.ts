// deploy for zia-network-services.
//
// What is specific to this type and worth driving end to end:
//   * the canvas authors ports as TEXTAREA LINES ("22", "8000-8100") and deploy
//     sends them as ZIA `{ start, end }` range objects — the parse is the part a
//     customer would notice going wrong;
//   * a port family with no lines is OMITTED from the body entirely, not sent
//     empty, so a TCP-only service does not claim an empty UDP set;
//   * a PREDEFINED (built-in) service must never be overwritten — deploy has to
//     refuse before it writes;
//   * ZIA STAGES writes, so nothing is visible until `/status/activate`;
//   * the update path must record the LIVE prior ports, which is the only thing
//     rollback can restore.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACTIVATED,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  writeCalls,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const SERVICE = item('Vendor SFTP', {
  name: 'Vendor SFTP',
  description: 'desired description',
  tcp_ports: '22\n8000-8100',
  udp_ports: '53',
})

/**
 * The live service, deliberately UNLIKE the canvas: different description,
 * different TCP ports, different UDP ports. A rollback entry that mirrors the
 * canvas rather than this has recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 7001,
  name: 'Vendor SFTP',
  type: 'CUSTOM',
  description: 'live description set by hand',
  destTcpPorts: [{ start: 21, end: 21 }],
  destUdpPorts: [{ start: 69, end: 69 }],
}

registerDeployGuardContract({ label: 'zia-network-services', handler: deploy, product: 'zia', items: [SERVICE] })

test('zia-network-services deploy: creates a service that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 7077, name: 'Something Else', type: 'CUSTOM' }]),
    created({ id: 7009, name: 'Vendor SFTP' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([SERVICE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/networkServices\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/networkServices$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Vendor SFTP')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.type, 'CUSTOM', 'a service this app manages is always CUSTOM')
    assert.deepEqual(body?.destTcpPorts, [
      { start: 22, end: 22 },
      { start: 8000, end: 8100 },
    ])
    assert.deepEqual(body?.destUdpPorts, [{ start: 53, end: 53 }])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Vendor SFTP', existed: false, id: 7009 }])
    assert.deepEqual(rollback.createdIds, [7009])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

// NOTE: the branch where ZIA answers the POST without an id is deliberately not
// asserted. deploy throws there BEFORE pushing the rollback entry, so the service
// it just created exists in the tenant with nothing recorded to delete it — see
// the report accompanying these tests. Asserting it would bless it.

test('zia-network-services deploy: a TCP-only service does not claim an empty UDP port set', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 7010 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([item('TCP Only', { name: 'TCP Only', tcp_ports: '443' })]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    const body = bodyOf(tenant[1])
    assert.deepEqual(body?.destTcpPorts, [{ start: 443, end: 443 }])
    assert.equal('destUdpPorts' in (body ?? {}), false, 'an unused port family is omitted, not sent empty')
    assert.equal(body?.description, '', 'a blank description must converge the live service')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-network-services deploy: updates an existing service and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 7001 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([SERVICE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a service that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/networkServices\/7001$/)
    assert.deepEqual(bodyOf(tenant[1])?.destTcpPorts, [
      { start: 22, end: 22 },
      { start: 8000, end: 8100 },
    ])

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{
        existed: boolean
        id: number
        prior: { description?: string; type?: string; destTcpPorts?: unknown; destUdpPorts?: unknown }
      }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 7001)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.deepEqual(entry.prior.destTcpPorts, [{ start: 21, end: 21 }])
    assert.deepEqual(entry.prior.destUdpPorts, [{ start: 69, end: 69 }])
    assert.equal(entry.prior.type, 'CUSTOM')
  } finally {
    restore()
  }
})

test('zia-network-services deploy: refuses to overwrite a predefined service, and writes nothing', async () => {
  const predefined = { id: 7099, name: 'Vendor SFTP', type: 'PREDEFINED' }
  const { calls, restore } = recordFetch([TOKEN, ziaList([predefined])])
  try {
    const result = await deploy(deployContext([SERVICE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /predefined network service/)
    assert.equal(writeCalls(calls).length, 0, 'a built-in service must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'a predefined service is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-network-services deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Port range overlaps an existing network service'),
  ])
  try {
    const result = await deploy(deployContext([SERVICE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Port range overlaps/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live service, so the prior ports deploy read
    // beforehand have to survive on the failure path or they can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { destTcpPorts?: unknown } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.deepEqual(rollback.previousState[0].prior?.destTcpPorts, [{ start: 21, end: 21 }])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-network-services deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/networkServices/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([SERVICE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list network services/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-network-services deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 7009 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([SERVICE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [7009], 'the staged object still exists and must be revertible')
  } finally {
    restore()
  }
})
