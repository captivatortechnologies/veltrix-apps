// driftDetect for log-sources.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: the whole log source list is read once and matched by name, and
// the two fields an operator most often changes by hand in the console —
// `enabled` and the description — are compared against what the last deploy
// recorded. A log source silently disabled in the console is exactly the change
// drift detection exists to surface: the customer stops receiving those events
// and nothing else says so.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  driftContext,
  item,
  list,
  pathOf,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const LS = '/config/event_sources/log_source_management/log_sources'

const FIREWALL = item('Perimeter Firewall', {
  name: 'Perimeter Firewall',
  typeName: 'Linux OS',
  protocolName: 'Syslog',
  protocolParameters: '[{"name":"identifier","value":"fw01"}]',
  description: 'Edge firewall syslog',
})

registerDriftGuardContract({ label: 'log-sources', handler: driftDetect, sampleItems: [FIREWALL] })

function live(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: 'Perimeter Firewall',
    type_id: 11,
    protocol_type_id: 7,
    enabled: true,
    description: 'Edge firewall syslog',
    ...over,
  }
}

test('log-sources driftDetect: reports in sync when the live source matches', async () => {
  const { calls, restore } = recordFetch([list([live()])])
  try {
    const result = await driftDetect(driftContext([FIREWALL]))

    assert.equal(pathOf(calls[0]), LS)
    assert.equal(calls[0].range, 'items=0-9999', 'a truncated read would report later sources absent')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('log-sources driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would look for a source that does not exist and report it missing.
  const { restore } = recordFetch([list([live()])])
  try {
    const result = await driftDetect(driftContext([FIREWALL]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('log-sources driftDetect: reports a source deleted in the console as critical', async () => {
  const { restore } = recordFetch([list([live({ name: 'Something Else' })])])
  try {
    const result = await driftDetect(driftContext([FIREWALL]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Perimeter Firewall', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, 'the list read answered, so the run did check')
  } finally {
    restore()
  }
})

test('log-sources driftDetect: reports a source disabled in the console', async () => {
  const { restore } = recordFetch([list([live({ enabled: false })])])
  try {
    const result = await driftDetect(driftContext([FIREWALL]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Perimeter Firewall.enabled')
    assert.ok(diff, `expected an enabled diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('log-sources driftDetect: reports a description edited in the console', async () => {
  const { restore } = recordFetch([list([live({ description: 'edited by hand' })])])
  try {
    const result = await driftDetect(driftContext([FIREWALL]))

    const diff = result.diffs.find((d) => d.field === 'Perimeter Firewall.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'Edge firewall syslog')
    assert.equal(diff.actual, 'edited by hand')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('log-sources driftDetect: matches the live source by name case-insensitively', async () => {
  // QRadar preserves the case an operator typed; a case-sensitive match would
  // report every such source as deleted.
  const { restore } = recordFetch([list([live({ name: 'perimeter firewall' })])])
  try {
    const result = await driftDetect(driftContext([FIREWALL]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('log-sources driftDetect: an empty deployed config compares nothing and reports in sync', async () => {
  const { calls, restore } = recordFetch([list([live()])])
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
