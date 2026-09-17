// driftDetect for remote-services.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: this type reads the whole staged list once and compares each
// declared service field by field, so the assertions below are about reading
// the DEPLOYED config rather than the live canvas, and about emitting a diff
// for every field that actually moved.

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

const PATH = '/staged_config/remote_services'

const CLOUD_BACKUP = item(
  'Cloud Backup',
  {
    name: 'Cloud Backup',
    description: 'Offsite backup targets',
    group: 'Sanctioned SaaS',
    cidrs: '198.51.100.0/24\n203.0.113.0/24',
  },
  'item-backup',
)

function liveService(over: Record<string, unknown> = {}) {
  return {
    id: 31,
    name: 'Cloud Backup',
    description: 'Offsite backup targets',
    group: 'Sanctioned SaaS',
    cidrs: ['198.51.100.0/24', '203.0.113.0/24'],
    ...over,
  }
}

registerDriftGuardContract({ label: 'remote-services', handler: driftDetect, sampleItems: [CLOUD_BACKUP] })

test('remote-services driftDetect: reports in sync when the live service matches', async () => {
  const { calls, restore } = recordFetch([list([liveService({ cidrs: ['203.0.113.0/24', '198.51.100.0/24'] })])])
  try {
    const result = await driftDetect(driftContext([CLOUD_BACKUP]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999', 'a partial page would report later services as deleted')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('remote-services driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would look for that name and report the real service as deleted.
  const { restore } = recordFetch([list([liveService()])])
  try {
    const result = await driftDetect(driftContext([CLOUD_BACKUP]))

    assert.equal(result.hasDrift, false, 'the decoy canvas item must not be compared')
  } finally {
    restore()
  }
})

test('remote-services driftDetect: reports a service deleted in the console as critical', async () => {
  // A 200 with an empty list is a real answer: the console says the service is
  // not there.
  const { restore } = recordFetch([list([])])
  try {
    const result = await driftDetect(driftContext([CLOUD_BACKUP]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Cloud Backup', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, 'an answered read did check')
  } finally {
    restore()
  }
})

test('remote-services driftDetect: reports CIDR ranges edited in the console', async () => {
  const { restore } = recordFetch([list([liveService({ cidrs: ['198.51.100.0/24', '192.0.2.0/24'] })])])
  try {
    const result = await driftDetect(driftContext([CLOUD_BACKUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Cloud Backup.cidrs')
    assert.ok(diff, `expected a cidrs diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, '198.51.100.0/24, 203.0.113.0/24')
    assert.equal(diff.actual, '198.51.100.0/24, 192.0.2.0/24')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('remote-services driftDetect: reports the description and the group separately', async () => {
  const { restore } = recordFetch([list([liveService({ description: 'renamed by hand', group: 'Unclassified' })])])
  try {
    const result = await driftDetect(driftContext([CLOUD_BACKUP]))

    assert.deepEqual(
      result.diffs.map((d) => [d.field, d.expected, d.actual]),
      [
        ['Cloud Backup.description', 'Offsite backup targets', 'renamed by hand'],
        ['Cloud Backup.group', 'Sanctioned SaaS', 'Unclassified'],
      ],
    )
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})

test('remote-services driftDetect: a service that lost its CIDRs entirely still reports a diff', async () => {
  // `cidrs` absent from the response must not read as "matches"; an emptied
  // remote service stops matching the traffic the rules were written against.
  const { restore } = recordFetch([
    list([{ id: 31, name: 'Cloud Backup', description: 'Offsite backup targets', group: 'Sanctioned SaaS' }]),
  ])
  try {
    const result = await driftDetect(driftContext([CLOUD_BACKUP]))

    const diff = result.diffs.find((d) => d.field === 'Cloud Backup.cidrs')
    assert.ok(diff)
    assert.equal(diff.actual, '')
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})

test('remote-services driftDetect: an empty deployed config reports in sync and writes nothing', async () => {
  const { calls, restore } = recordFetch([list([])])
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

// NOTE: `listRemoteServices` (deploy.ts:31) returns [] when the list read fails,
// so a 500 makes every declared service report `actual: 'absent', severity:
// 'critical'` with no `checked: false`. That path is deliberately unasserted —
// it is a defect, not a contract.
