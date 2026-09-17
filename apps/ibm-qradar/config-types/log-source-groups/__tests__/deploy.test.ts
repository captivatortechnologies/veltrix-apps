// deploy for log-source-groups.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the APPEND-ONLY shape plus the worklist: the API has no update and no delete,
// so a group that already exists must be recorded with NO write at all, and a
// group whose parent is declared LATER in the same canvas must still be created
// after that parent, carrying the parent_id the parent's create returned.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  bodyOf,
  created,
  deployContext,
  item,
  leaksToken,
  list,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/config/event_sources/log_source_management/log_source_groups'

const FIREWALLS = item('Firewalls', { name: 'Firewalls', description: 'Perimeter firewalls', parentName: '' }, 'item-fw')
const PALO_ALTO = item('Palo Alto', { name: 'Palo Alto', description: '', parentName: 'Firewalls' }, 'item-pan')

registerDeployGuardContract({ label: 'log-source-groups', handler: deploy, sampleItems: [FIREWALLS] })

test('log-source-groups deploy: creates a group that does not exist and records it as created', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 90, name: 'Firewalls' })])
  try {
    const result = await deploy(deployContext([FIREWALLS]))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999', 'the whole list is read, not the first page')

    assert.equal(calls.length, 2)
    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), PATH)
    assert.deepEqual(bodyOf(calls[1]), { name: 'Firewalls', description: 'Perimeter firewalls' })

    assert.equal(result.success, true)
    assert.match(String(result.message), /Ensured 1 log source group\(s\) \(1 created\)/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: 'item-fw', name: 'Firewalls', existed: false, id: 90 }])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-source-groups deploy: a group that already exists is recorded as existing with NO write', async () => {
  // There is no update endpoint, so touching a live group is not just
  // unnecessary — it would create a duplicate that can never be removed.
  const { calls, restore } = recordFetch([list([{ id: 12, name: 'Firewalls', description: 'set up by hand' }])])
  try {
    const result = await deploy(deployContext([FIREWALLS]))

    assert.equal(calls.length, 1, 'an existing group is read and left alone')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /\(0 created\)/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: 'item-fw', name: 'Firewalls', existed: true, id: 12 }])
  } finally {
    restore()
  }
})

test('log-source-groups deploy: matches an existing group case-insensitively', async () => {
  const { calls, restore } = recordFetch([list([{ id: 12, name: 'FIREWALLS' }])])
  try {
    const result = await deploy(deployContext([FIREWALLS]))

    assert.equal(writeCalls(calls).length, 0, 'a case difference must not create a second group')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-source-groups deploy: a child declared BEFORE its parent is still created after it', async () => {
  // The canvas has no ordering guarantee, so the deploy repeats passes. Creating
  // the child first would either fail or land it at the root, and there is no
  // re-parent endpoint to fix it afterwards.
  const { calls, restore } = recordFetch([list([]), created({ id: 90, name: 'Firewalls' }), created({ id: 91, name: 'Palo Alto' })])
  try {
    const result = await deploy(deployContext([PALO_ALTO, FIREWALLS]))

    assert.deepEqual(
      calls.slice(1).map((c) => bodyOf(c)),
      [
        { name: 'Firewalls', description: 'Perimeter firewalls' },
        { name: 'Palo Alto', parent_id: 90 },
      ],
      'the parent is created first and the child carries the id its create returned',
    )
    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries.map((e) => e.name), ['Firewalls', 'Palo Alto'])
  } finally {
    restore()
  }
})

test('log-source-groups deploy: resolves a parent that already exists in the console', async () => {
  const { calls, restore } = recordFetch([list([{ id: 12, name: 'Firewalls' }]), created({ id: 91 })])
  try {
    const result = await deploy(deployContext([PALO_ALTO]))

    assert.deepEqual(bodyOf(calls[1]), { name: 'Palo Alto', parent_id: 12 })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-source-groups deploy: an unresolvable parent fails with "unknown parent group" instead of looping', async () => {
  // The worklist only repeats while it makes progress. If that guard broke, this
  // test would hang rather than fail — which is the point of asserting it.
  const ORPHAN = item('Orphan', { name: 'Orphan', description: '', parentName: 'Does Not Exist' }, 'item-orphan')
  const { calls, restore } = recordFetch([list([])])
  try {
    const result = await deploy(deployContext([ORPHAN]))

    assert.equal(calls.length, 1, 'a group whose parent cannot be resolved must not be created at the root')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /Orphan: unknown parent group "Does Not Exist"/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-source-groups deploy: a rejected parent create stops its children without looping forever', async () => {
  const { calls, restore } = recordFetch([list([]), qradarError(422, 'A group with that name already exists')])
  try {
    const result = await deploy(deployContext([FIREWALLS, PALO_ALTO]))

    assert.equal(calls.length, 2, 'the failed parent is not retried and the child is never created')
    assert.equal(result.success, false)
    assert.match(String(result.message), /Firewalls: A group with that name already exists/)
    assert.match(String(result.message), /Palo Alto: unknown parent group "Firewalls"/)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})

test('log-source-groups deploy: a rejected create is a failed result that still records what was created', async () => {
  const OTHER = item('Proxies', { name: 'Proxies', description: '', parentName: '' }, 'item-proxy')
  const { restore } = recordFetch([list([]), created({ id: 90 }), qradarError(403, 'You do not have the required capability for this endpoint')])
  try {
    const result = await deploy(deployContext([FIREWALLS, OTHER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /required capability/)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries.map((e) => e.name), ['Firewalls'], 'the group that WAS created stays recorded')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-source-groups deploy: a blank parent name creates the group at the root', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 90 })])
  try {
    await deploy(deployContext([FIREWALLS]))

    assert.equal('parent_id' in (bodyOf(calls[1]) ?? {}), false, 'a root group must not be sent a parent_id')
  } finally {
    restore()
  }
})

test('log-source-groups deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = recordFetch([list([])])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})

test('log-source-groups deploy: canvas snapshots that carry only `sections` are read too', async () => {
  // The platform still ships the deprecated `sections` alias; the extractor
  // falls back to it, and a fixture that only sets `items` would never prove it.
  const ctx = deployContext([])
  const sectionsOnly = { ...ctx.canvas, items: undefined as unknown as [], sections: [FIREWALLS] }
  const { calls, restore } = recordFetch([list([]), created({ id: 90 })])
  try {
    await deploy({ ...ctx, canvas: sectionsOnly } as typeof ctx)

    assert.equal(calls.length, 2, 'a sections-only canvas must still deploy')
    assert.deepEqual(bodyOf(calls[1]), { name: 'Firewalls', description: 'Perimeter firewalls' })
  } finally {
    restore()
  }
})

// NOTE: `listJson` (lib/lookups.ts:78) returns [] when the list read fails, so a
// 500 there sends every declared group down the CREATE branch — and with no
// delete endpoint those duplicates are permanent. That path is deliberately
// unasserted: a test for it would document the bug as correct.
//
// Also unasserted: a create that answers 2xx without an id leaves the group out
// of `resolvedByName` (deploy.ts:95), so its children then fail with "unknown
// parent group" even though the parent now exists.
