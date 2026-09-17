// driftDetect for tagged-field-categories.
//
// The shared contract covers the refusals (as `checked: false`, never a bare
// "in sync") and the read-only rule. A category has no mutable state beyond its
// name, and the name IS the identity this handler matches on, so presence is the
// whole comparison: a category deleted in the console takes the custom Ariel
// properties filed under it out of every saved search that groups by it.

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

const USERNAME = item('Username', { name: 'Username' }, 'itm-username')

registerDriftGuardContract({ label: 'tagged-field-categories', handler: driftDetect, sampleItems: [USERNAME] })

function liveCategory(over: Record<string, unknown> = {}) {
  return { id: 7, name: 'Username', uuid: 'c0ffee', ...over }
}

test('tagged-field-categories driftDetect: reports in sync when the category is present', async () => {
  const { calls, restore } = recordFetch([list([liveCategory()])])
  try {
    const result = await driftDetect(driftContext([USERNAME]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), '/ariel/taggedfieldcategories')
    assert.equal(calls[0].range, 'items=0-9999', 'a category past the first page is not drift')
    assert.equal(writeCalls(calls).length, 0, 'drift detection is read-only')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
  } finally {
    restore()
  }
})

test('tagged-field-categories driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would report the decoy as missing and the real category as unchecked.
  const { restore } = recordFetch([list([liveCategory()])])
  try {
    const result = await driftDetect(driftContext([USERNAME]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('tagged-field-categories driftDetect: matching the live name is case-insensitive', async () => {
  // Deploy matches case-insensitively, so drift must too — otherwise every run
  // reports a category the deploy considers deployed as critically missing.
  const { restore } = recordFetch([list([liveCategory({ name: 'username' })])])
  try {
    const result = await driftDetect(driftContext([USERNAME]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('tagged-field-categories driftDetect: reports a category missing from the live list as critical', async () => {
  const { restore } = recordFetch([list([liveCategory({ id: 1, name: 'Unrelated' })])])
  try {
    const result = await driftDetect(driftContext([USERNAME]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Username', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, 'an answered list read is a real check')
  } finally {
    restore()
  }
})

test('tagged-field-categories driftDetect: reports every missing category, not just the first', async () => {
  const HOSTNAME = item('Hostname', { name: 'Hostname' }, 'itm-hostname')
  const { restore } = recordFetch([list([liveCategory()])])
  try {
    const result = await driftDetect(driftContext([USERNAME, HOSTNAME]))

    assert.deepEqual(result.diffs.map((d) => d.field), ['Hostname'])
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})
