// driftDetect for domains.
//
// The shared contract covers the refusals (as `checked: false`, never a bare
// "in sync") and the read-only rule. What is specific here: the single
// range-paged read of the collection, the match by lowercased name, and the two
// verdicts an operator acts on — a domain edited in the console (warning) and a
// domain that is no longer there at all (critical).

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  driftContext,
  item,
  list,
  pathOf,
  recordFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const CORP = item('Corp', { name: 'Corp', description: 'Corporate network' }, 'itm-corp')

registerDriftGuardContract({ label: 'domains', handler: driftDetect, sampleItems: [CORP] })

function liveDomain(over: Record<string, unknown> = {}) {
  return { id: 7, name: 'Corp', description: 'Corporate network', deleted: false, ...over }
}

test('domains driftDetect: reports in sync when the live domain matches', async () => {
  const { calls, restore } = recordFetch([list([liveDomain()])])
  try {
    const result = await driftDetect(driftContext([CORP]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), '/config/domain_management/domains')
    assert.equal(calls[0].range, 'items=0-9999', 'a domain past the first page is not drift')
    assert.equal(writeCalls(calls).length, 0, 'drift detection is read-only')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
  } finally {
    restore()
  }
})

test('domains driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would report the decoy as missing and the real domain as unchecked.
  const { restore } = recordFetch([list([liveDomain()])])
  try {
    const result = await driftDetect(driftContext([CORP]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('domains driftDetect: reports a description edited in the console as a warning', async () => {
  const { restore } = recordFetch([list([liveDomain({ description: 'edited by hand in the console' })])])
  try {
    const result = await driftDetect(driftContext([CORP]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: 'Corp.description',
        expected: 'Corporate network',
        actual: 'edited by hand in the console',
        severity: 'warning',
      },
    ])
    assert.equal(result.checked, undefined)
  } finally {
    restore()
  }
})

test('domains driftDetect: reports a domain missing from the live list as critical', async () => {
  const { restore } = recordFetch([list([liveDomain({ id: 1, name: 'Unrelated' })])])
  try {
    const result = await driftDetect(driftContext([CORP]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [{ field: 'Corp', expected: 'present', actual: 'absent', severity: 'critical' }])
  } finally {
    restore()
  }
})

test('domains driftDetect: an unreadable console is not reported as every domain deleted', async () => {
  // The listing used to return [] on any non-2xx, so a transient 500 emitted
  // `actual: 'absent', severity: 'critical'` for every declared domain — paging
  // somebody for deletions that never happened, whose obvious remedy is a
  // redeploy of things that were never gone.
  const { restore } = recordFetch([serverError('Console is restarting')])
  try {
    const result = await driftDetect(driftContext([CORP]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, false, 'a run that could not look must say so')
  } finally {
    restore()
  }
})

test('domains driftDetect: a soft-deleted domain reads as absent, not as present', async () => {
  // The row is still returned by the console; only `deleted: true` says the
  // domain is gone. A handler that ignored the flag would report in sync while
  // events routed through that domain are being dropped.
  const { restore } = recordFetch([list([liveDomain({ deleted: true })])])
  try {
    const result = await driftDetect(driftContext([CORP]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].severity, 'critical')
    assert.equal(result.diffs[0].actual, 'absent')
  } finally {
    restore()
  }
})

test('domains driftDetect: reports every drifted domain, not just the first', async () => {
  const OPS = item('Ops', { name: 'Ops', description: 'Operations network' }, 'itm-ops')
  const { restore } = recordFetch([list([liveDomain({ description: 'changed' })])])
  try {
    const result = await driftDetect(driftContext([CORP, OPS]))

    assert.deepEqual(result.diffs.map((d) => d.field), ['Corp.description', 'Ops'])
  } finally {
    restore()
  }
})
