// driftDetect for log-source-types.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: the declared protocol NAME has to be resolved through the same
// read-only lookup deploy uses before the live `default_protocol_id` means
// anything, so the comparison spans two reads.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, pathOf, routeFetch, writeCalls } from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const TYPES = '/config/event_sources/log_source_management/log_source_types'
const PROTOCOLS = '/config/event_sources/log_source_management/protocol_types'

const SYSLOG = { id: 7, name: 'Syslog' }
const JDBC = { id: 3, name: 'JDBC' }

const ACME = item('Acme Firewall', { name: 'Acme Firewall', defaultProtocolName: 'Syslog' }, 'item-acme')

registerDriftGuardContract({ label: 'log-source-types', handler: driftDetect, sampleItems: [ACME] })

function fakeConsole(opts: { protocols?: unknown[]; types?: unknown[] } = {}) {
  return routeFetch([
    { url: /\/protocol_types/, respond: list(opts.protocols ?? [SYSLOG, JDBC]) },
    { url: /\/log_source_types/, respond: list(opts.types ?? []) },
  ])
}

test('log-source-types driftDetect: reports in sync when the live type matches', async () => {
  const { calls, restore } = fakeConsole({
    types: [{ id: 44, name: 'Acme Firewall', internal: false, default_protocol_id: 7 }],
  })
  try {
    const result = await driftDetect(driftContext([ACME]))

    assert.ok(calls.some((c) => pathOf(c) === PROTOCOLS))
    assert.ok(calls.some((c) => pathOf(c) === TYPES))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('log-source-types driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would look for that name and report the real type as deleted.
  const { restore } = fakeConsole({
    types: [{ id: 44, name: 'Acme Firewall', internal: false, default_protocol_id: 7 }],
  })
  try {
    const result = await driftDetect(driftContext([ACME]))

    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('log-source-types driftDetect: reports a type deleted in the console as critical', async () => {
  // The console answered the list; the type simply is not in it.
  const { restore } = fakeConsole({ types: [{ id: 99, name: 'Something Else' }] })
  try {
    const result = await driftDetect(driftContext([ACME]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Acme Firewall', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('log-source-types driftDetect: reports a default protocol repointed in the console', async () => {
  // A DSM quietly moved from Syslog to JDBC stops parsing the events it was
  // built for — the drift run is the only thing that will say so.
  const { restore } = fakeConsole({
    types: [{ id: 44, name: 'Acme Firewall', internal: false, default_protocol_id: 3 }],
  })
  try {
    const result = await driftDetect(driftContext([ACME]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Acme Firewall.defaultProtocol')
    assert.ok(diff, `expected a defaultProtocol diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, 'Syslog')
    assert.equal(diff.actual, '3')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('log-source-types driftDetect: a type deployed without a protocol is compared on presence alone', async () => {
  const BARE = item('Bare Type', { name: 'Bare Type' }, 'item-bare')
  const { restore } = fakeConsole({ types: [{ id: 50, name: 'Bare Type', default_protocol_id: 3 }] })
  try {
    const result = await driftDetect(driftContext([BARE]))

    assert.equal(result.hasDrift, false, 'nothing was declared about the protocol, so nothing drifted')
    assert.equal(result.checked, undefined)
  } finally {
    restore()
  }
})

test('log-source-types driftDetect: one missing type does not hide drift on another', async () => {
  const OTHER = item('Acme Database', { name: 'Acme Database', defaultProtocolName: 'JDBC' }, 'item-db')
  const { restore } = fakeConsole({
    types: [{ id: 44, name: 'Acme Firewall', internal: false, default_protocol_id: 3 }],
  })
  try {
    const result = await driftDetect(driftContext([ACME, OTHER]))

    assert.deepEqual(result.diffs.map((d) => d.field), ['Acme Firewall.defaultProtocol', 'Acme Database'])
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})

test('log-source-types driftDetect: an empty deployed config checks nothing and never writes', async () => {
  const { calls, restore } = fakeConsole({ types: [] })
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
