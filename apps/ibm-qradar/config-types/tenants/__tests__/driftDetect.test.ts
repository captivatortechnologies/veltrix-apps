// driftDetect for tenants.
//
// The shared contract covers the refusals (as `checked: false`, never a bare
// "in sync") and the read-only rule. What is specific here: the single
// range-paged read, the match by lowercased name, and the verdicts an operator
// acts on — a description or a rate cap changed in the console (warning) and a
// tenant that is no longer there (critical). A rate cap silently lowered in the
// console drops events, which is exactly what drift detection exists to surface.

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

const RESEARCH = item(
  'Research',
  { name: 'Research', description: 'Research business unit', eventRateLimit: 5000, flowRateLimit: 2500 },
  'itm-research',
)

registerDriftGuardContract({ label: 'tenants', handler: driftDetect, sampleItems: [RESEARCH] })

function liveTenant(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'Research',
    description: 'Research business unit',
    event_rate_limit: 5000,
    flow_rate_limit: 2500,
    deleted: false,
    ...over,
  }
}

test('tenants driftDetect: reports in sync when the live tenant matches', async () => {
  const { calls, restore } = recordFetch([list([liveTenant()])])
  try {
    const result = await driftDetect(driftContext([RESEARCH]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), '/config/access/tenant_management/tenants')
    assert.equal(calls[0].range, 'items=0-9999', 'a tenant past the first page is not drift')
    assert.equal(writeCalls(calls).length, 0, 'drift detection is read-only')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
  } finally {
    restore()
  }
})

test('tenants driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would report the decoy as missing and the real tenant as unchecked.
  const { restore } = recordFetch([list([liveTenant()])])
  try {
    const result = await driftDetect(driftContext([RESEARCH]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('tenants driftDetect: reports a description edited in the console as a warning', async () => {
  const { restore } = recordFetch([list([liveTenant({ description: 'edited by hand in the console' })])])
  try {
    const result = await driftDetect(driftContext([RESEARCH]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: 'Research.description',
        expected: 'Research business unit',
        actual: 'edited by hand in the console',
        severity: 'warning',
      },
    ])
    assert.equal(result.checked, undefined)
  } finally {
    restore()
  }
})

test('tenants driftDetect: reports a rate cap lowered in the console as a warning', async () => {
  const { restore } = recordFetch([list([liveTenant({ event_rate_limit: 100, flow_rate_limit: 50 })])])
  try {
    const result = await driftDetect(driftContext([RESEARCH]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Research.eventRateLimit', expected: '5000', actual: '100', severity: 'warning' },
      { field: 'Research.flowRateLimit', expected: '2500', actual: '50', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('tenants driftDetect: reports a tenant missing from the live list as critical', async () => {
  const { restore } = recordFetch([list([liveTenant({ id: 1, name: 'Unrelated' })])])
  try {
    const result = await driftDetect(driftContext([RESEARCH]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Research', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('tenants driftDetect: a soft-deleted tenant reads as absent, not as present', async () => {
  // The row is still returned by the console; only `deleted: true` says the
  // tenant is gone. A handler that ignored the flag would report in sync while
  // the tenant's data separation no longer exists.
  const { restore } = recordFetch([list([liveTenant({ deleted: true })])])
  try {
    const result = await driftDetect(driftContext([RESEARCH]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].severity, 'critical')
    assert.equal(result.diffs[0].actual, 'absent')
  } finally {
    restore()
  }
})

test('tenants driftDetect: reports every drifted tenant, not just the first', async () => {
  const OPS = item('Ops', { name: 'Ops', description: 'Operations' }, 'itm-ops')
  const { restore } = recordFetch([list([liveTenant({ description: 'changed' })])])
  try {
    const result = await driftDetect(driftContext([RESEARCH, OPS]))

    assert.deepEqual(result.diffs.map((d) => d.field), ['Research.description', 'Ops'])
  } finally {
    restore()
  }
})
