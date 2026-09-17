// driftDetect for bandwidth-manager.
//
// The shared contract covers the refusals (as `checked: false`, never a bare
// "in sync") and the read-only rule. What is specific here: the single
// range-paged read, the match by lowercased name, and the verdicts an operator
// acts on — a cap, a managed host or a hostname changed in the console
// (warning), and a configuration that is no longer there (critical). A cap
// lowered by hand throttles store-and-forward for that appliance, which is
// exactly the change drift detection exists to surface.

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

const EDGE = item(
  'Edge Cap',
  { name: 'Edge Cap', hostname: 'ep1.example.test', hostId: 3, kbLimit: 5000, deviceName: 'eth0' },
  'itm-edge',
)

registerDriftGuardContract({ label: 'bandwidth-manager', handler: driftDetect, sampleItems: [EDGE] })

function liveConfig(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'Edge Cap',
    hostname: 'ep1.example.test',
    host_id: 3,
    kb_limit: 5000,
    device_name: 'eth0',
    ...over,
  }
}

test('bandwidth-manager driftDetect: reports in sync when the live configuration matches', async () => {
  const { calls, restore } = recordFetch([list([liveConfig()])])
  try {
    const result = await driftDetect(driftContext([EDGE]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), '/bandwidth_manager/configurations')
    assert.equal(calls[0].range, 'items=0-9999', 'a configuration past the first page is not drift')
    assert.equal(writeCalls(calls).length, 0, 'drift detection is read-only')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
  } finally {
    restore()
  }
})

test('bandwidth-manager driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would report the decoy as missing and the real cap as unchecked.
  const { restore } = recordFetch([list([liveConfig()])])
  try {
    const result = await driftDetect(driftContext([EDGE]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('bandwidth-manager driftDetect: reports a cap lowered in the console as a warning', async () => {
  const { restore } = recordFetch([list([liveConfig({ kb_limit: 128 })])])
  try {
    const result = await driftDetect(driftContext([EDGE]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Edge Cap.kbLimit', expected: '5000', actual: '128', severity: 'warning' },
    ])
    assert.equal(result.checked, undefined)
  } finally {
    restore()
  }
})

test('bandwidth-manager driftDetect: reports a cap repointed at another managed host or link', async () => {
  const { restore } = recordFetch([list([liveConfig({ host_id: 9, hostname: 'ep9.example.test' })])])
  try {
    const result = await driftDetect(driftContext([EDGE]))

    assert.deepEqual(result.diffs, [
      { field: 'Edge Cap.hostId', expected: '3', actual: '9', severity: 'warning' },
      { field: 'Edge Cap.hostname', expected: 'ep1.example.test', actual: 'ep9.example.test', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('bandwidth-manager driftDetect: reports a configuration missing from the live list as critical', async () => {
  const { restore } = recordFetch([list([liveConfig({ id: 1, name: 'Unrelated' })])])
  try {
    const result = await driftDetect(driftContext([EDGE]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Edge Cap', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, 'an answered list read is a real check')
  } finally {
    restore()
  }
})

test('bandwidth-manager driftDetect: reports every drifted configuration, not just the first', async () => {
  const CORE = item('Core Cap', { name: 'Core Cap', hostname: 'core.example.test', hostId: 4, deviceName: 'eth0' }, 'itm-core')
  const { restore } = recordFetch([list([liveConfig({ kb_limit: 128 })])])
  try {
    const result = await driftDetect(driftContext([EDGE, CORE]))

    assert.deepEqual(result.diffs.map((d) => d.field), ['Edge Cap.kbLimit', 'Core Cap'])
  } finally {
    restore()
  }
})
