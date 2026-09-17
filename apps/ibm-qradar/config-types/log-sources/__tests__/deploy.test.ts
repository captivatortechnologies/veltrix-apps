// deploy for log-sources.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// that three separate name resolutions happen before a single byte is written:
// the log source TYPE and the PROTOCOL are declared by name, and every protocol
// parameter's numeric id is filled in from the CHOSEN protocol's own definition.
// A wrong id here does not fail loudly — the console stores a log source whose
// protocol configuration points at the wrong field, and the customer's events
// stop being parsed.

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

const LS = '/config/event_sources/log_source_management/log_sources'
const TYPES = '/config/event_sources/log_source_management/log_source_types'
const PROTOCOLS = '/config/event_sources/log_source_management/protocol_types'

const LINUX_TYPE = { id: 11, name: 'Linux OS' }
const WINDOWS_TYPE = { id: 12, name: 'Microsoft Windows Security Event Log' }

/**
 * Two protocols whose parameter NAMES collide on different ids. Any test that
 * declares "Syslog" and reads back 555 has taken the id from the wrong protocol.
 */
const SYSLOG = {
  id: 7,
  name: 'Syslog',
  parameters: [
    { id: 901, name: 'identifier', required: true },
    { id: 902, name: 'port' },
  ],
}
const JDBC = {
  id: 8,
  name: 'JDBC',
  parameters: [
    { id: 555, name: 'identifier' },
    { id: 556, name: 'port' },
  ],
}

// `Port` is deliberately cased differently from the protocol definition's
// `port`, and the blob carries an `id` the parser ignores — both are how a real
// canvas arrives, and both must still resolve to the definition's id.
const FIREWALL = item('Perimeter Firewall', {
  name: 'Perimeter Firewall',
  typeName: 'Linux OS',
  protocolName: 'Syslog',
  protocolParameters: '[{"name":"identifier","value":"fw01","id":1},{"name":"Port","value":"514"}]',
  description: 'Edge firewall syslog',
  credibility: 8,
})

registerDeployGuardContract({ label: 'log-sources', handler: deploy, sampleItems: [FIREWALL] })

interface RouteOverrides {
  types?: CannedResponse
  protocols?: CannedResponse
  logSources?: CannedResponse
  create?: CannedResponse
  update?: CannedResponse
  remove?: CannedResponse
}

/**
 * The three lookup reads this deploy fans out over in `Promise.all` plus the
 * writes. URL-matched rather than queued: the order of the fan-out is an
 * implementation detail, not a contract.
 */
function routes(over: RouteOverrides = {}): Route[] {
  return [
    { url: /\/log_source_types$/, respond: over.types ?? list([LINUX_TYPE, WINDOWS_TYPE]) },
    { url: /\/protocol_types$/, respond: over.protocols ?? list([SYSLOG, JDBC]) },
    { url: /\/log_sources$/, method: 'GET', respond: over.logSources ?? list([]) },
    { url: /\/log_sources$/, method: 'POST', respond: over.create ?? created({ id: 77 }) },
    { url: /\/log_sources\/\d+$/, method: 'POST', respond: over.update ?? ok({}) },
    { url: /\/log_sources\/\d+$/, method: 'DELETE', respond: over.remove ?? ACCEPTED },
  ]
}

/** A live log source that matches FIREWALL field for field. */
function liveFirewall(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: 'Perimeter Firewall',
    type_id: 11,
    protocol_type_id: 7,
    enabled: true,
    description: 'Edge firewall syslog',
    credibility: 8,
    protocol_parameters: [
      { id: 902, name: 'port', value: '514' },
      { id: 901, name: 'identifier', value: 'fw01' },
    ],
    ...over,
  }
}

function entriesOf(result: { rollbackData?: unknown }): Array<Record<string, unknown>> {
  return (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
}

test('log-sources deploy: creates a source that does not exist, with ids resolved from the lookups', async () => {
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(deployContext([FIREWALL]))

    assertQRadarHeaders(assert, calls)
    for (const path of [TYPES, PROTOCOLS, LS]) {
      const read = calls.find((c) => c.method === 'GET' && pathOf(c) === path)
      assert.ok(read, `expected a GET of ${path}`)
      assert.equal(read.range, 'items=0-9999', 'a truncated lookup would silently fail to resolve names')
    }

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST')
    assert.equal(pathOf(writes[0]), LS, 'a create posts to the collection, not to an id')

    const body = bodyOf(writes[0])
    assert.ok(body)
    assert.equal(body.type_id, 11)
    assert.equal(body.protocol_type_id, 7)
    assert.equal(body.enabled, true)
    assert.equal(body.description, 'Edge firewall syslog')
    assert.equal(body.credibility, 8)

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, false, 'a source this deploy created must be marked not pre-existing')
    assert.equal(entries[0].id, 77, 'without the created id rollback cannot delete what it made')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-sources deploy: protocol parameter ids come from the protocol definition, not the canvas', async () => {
  // The canvas blob carries `"id": 1`. Writing that would point the parameter at
  // whatever parameter 1 happens to be for this protocol.
  const { calls, restore } = routeFetch(routes())
  try {
    await deploy(deployContext([FIREWALL]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    assert.deepEqual(body.protocol_parameters, [
      { id: 901, name: 'identifier', value: 'fw01' },
      { id: 902, name: 'Port', value: '514' },
    ])
  } finally {
    restore()
  }
})

test('log-sources deploy: the ids come from the CHOSEN protocol when two protocols share parameter names', async () => {
  // Syslog and JDBC both define `identifier`/`port` on different ids. A handler
  // indexing every protocol's parameters together would pick either one.
  const viaJdbc = item('Billing DB', {
    name: 'Billing DB',
    typeName: 'Linux OS',
    protocolName: 'JDBC',
    protocolParameters: '[{"name":"identifier","value":"billing"},{"name":"port","value":"1521"}]',
  })
  const { calls, restore } = routeFetch(routes())
  try {
    await deploy(deployContext([viaJdbc]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    assert.equal(body.protocol_type_id, 8)
    assert.deepEqual(body.protocol_parameters, [
      { id: 555, name: 'identifier', value: 'billing' },
      { id: 556, name: 'port', value: '1521' },
    ])
  } finally {
    restore()
  }
})

test('log-sources deploy: a protocol parameter the protocol does not define fails the item without writing', async () => {
  // There is no id to send, and writing the parameter without one would have the
  // console either reject the whole log source or store a parameter it cannot
  // map back to the protocol.
  const bogusParam = item('Perimeter Firewall', {
    name: 'Perimeter Firewall',
    typeName: 'Linux OS',
    protocolName: 'Syslog',
    protocolParameters: '[{"name":"syslogFacility","value":"local7"}]',
  })
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(deployContext([bogusParam]))

    assert.equal(writeCalls(calls).length, 0, 'nothing may be written for an unresolvable parameter')
    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown protocol parameter "syslogFacility" for protocol "Syslog"/)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

test('log-sources deploy: an unresolvable log source type fails only that item, and writes nothing for it', async () => {
  // type_id is a foreign key. A handler that carried on would POST `undefined`
  // and leave a log source attached to no parser at all.
  const unknownType = item('Datacenter Switch', {
    name: 'Datacenter Switch',
    typeName: 'Nonexistent Type',
    protocolName: 'Syslog',
    protocolParameters: '[{"name":"identifier","value":"sw01"}]',
  })
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(deployContext([FIREWALL, unknownType]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'only the resolvable item may be written')
    assert.equal(bodyOf(writes[0])?.name, 'Perimeter Firewall')

    assert.equal(result.success, false)
    assert.match(String(result.message), /Datacenter Switch: unknown log source type "Nonexistent Type"/)
    assert.equal(entriesOf(result).length, 1, 'the item that did deploy is still recorded for rollback')
  } finally {
    restore()
  }
})

test('log-sources deploy: an unresolvable protocol name fails the item without writing', async () => {
  const unknownProtocol = item('Perimeter Firewall', {
    name: 'Perimeter Firewall',
    typeName: 'Linux OS',
    protocolName: 'Nonexistent Protocol',
    protocolParameters: '[{"name":"identifier","value":"fw01"}]',
  })
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(deployContext([unknownProtocol]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown protocol "Nonexistent Protocol"/)
  } finally {
    restore()
  }
})

test('log-sources deploy: updates an existing source and records the LIVE prior body, not the canvas', async () => {
  // The live source differs from the canvas in the description, the credibility
  // and one protocol parameter VALUE. Recording the canvas as "prior" would look
  // right on a no-op deploy and silently discard the operator's settings the
  // moment a rollback ran.
  const live = liveFirewall({
    description: 'Edge firewall syslog (operator wording)',
    credibility: 5,
    protocol_parameters: [
      { id: 901, name: 'identifier', value: 'fw01-operator-edit' },
      { id: 902, name: 'port', value: '1514' },
    ],
  })
  const { calls, restore } = routeFetch(routes({ logSources: list([live]) }))
  try {
    const result = await deploy(deployContext([FIREWALL]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), `${LS}/42`, 'an update posts to the existing id')
    assert.deepEqual(bodyOf(writes[0])?.protocol_parameters, [
      { id: 901, name: 'identifier', value: 'fw01' },
      { id: 902, name: 'Port', value: '514' },
    ])

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 42)
    assert.deepEqual(entries[0].prior, {
      name: 'Perimeter Firewall',
      type_id: 11,
      protocol_type_id: 7,
      protocol_parameters: [
        { id: 901, name: 'identifier', value: 'fw01-operator-edit' },
        { id: 902, name: 'port', value: '1514' },
      ],
      enabled: true,
      description: 'Edge firewall syslog (operator wording)',
      credibility: 5,
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-sources deploy: writes nothing when the live source already matches, but still records rollback', async () => {
  // The live parameters are the same map in a different ORDER — comparing the
  // serialised list rather than the map would rewrite an identical log source on
  // every deploy, which restarts its protocol connection each time.
  const { calls, restore } = routeFetch(routes({ logSources: list([liveFirewall()]) }))
  try {
    const result = await deploy(deployContext([FIREWALL]))

    assert.equal(writeCalls(calls).length, 0, 'an identical log source must not be rewritten')
    const entries = entriesOf(result)
    assert.equal(entries.length, 1, 'a skipped write still needs a rollback entry')
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 42)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-sources deploy: a changed protocol parameter VALUE does trigger the update', async () => {
  // The mirror of the test above: equality is compared over the parameter map,
  // so a value someone edited in the console must come back.
  const drifted = liveFirewall({
    protocol_parameters: [
      { id: 901, name: 'identifier', value: 'fw01' },
      { id: 902, name: 'port', value: '9999' },
    ],
  })
  const { calls, restore } = routeFetch(routes({ logSources: list([drifted]) }))
  try {
    await deploy(deployContext([FIREWALL]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), `${LS}/42`)
  } finally {
    restore()
  }
})

test('log-sources deploy: a rejected create is a failed result, not a thrown error', async () => {
  const { restore } = routeFetch(routes({ create: qradarError(422, 'A log source with this name already exists') }))
  try {
    const result = await deploy(deployContext([FIREWALL]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-sources deploy: removes a source it created before and no longer declares', async () => {
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(
      deployContext([FIREWALL], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Collector', existed: false, id: 91 },
            { name: 'Operator Owned', existed: true, id: 92 },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${LS}/91`])
    assert.equal(
      deletes.includes(`${LS}/92`),
      false,
      'a log source that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-sources deploy: an empty canvas writes nothing', async () => {
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
