import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parsePermissions, groupsFromGroupsAction, reconcile, fetchAllGroupPerms, type GroupsActionPage } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the SonarQube Web API via node:http(s), which is
 * impractical to mock here. Tests focus on validate.ts and _shared (pure, network-free —
 * fetchAllGroupPerms takes an injected page-fetcher so it is exercised with a mock too).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.groupName ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { groupName: 'sonar-administrators', permissions: 'admin, scan' }

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed group grant', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing group name', async () => {
  const res = await validate(ctxOf([{ ...good, groupName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_GROUP'))
})

test('validate rejects blank permissions', async () => {
  const res = await validate(ctxOf([{ ...good, permissions: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PERMISSIONS'))
})

test('validate rejects an unknown permission token', async () => {
  const res = await validate(ctxOf([{ ...good, permissions: 'admin, superuser' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'UNKNOWN_PERMISSION'))
})

test('validate warns on a duplicate group name', async () => {
  const res = await validate(ctxOf([good, { ...good, permissions: 'gateadmin' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_GROUP'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- parsePermissions ---------------------------------------------------------

test('parsePermissions dedupes, lower-cases and ignores comments / blanks', () => {
  const { permissions, errors } = parsePermissions('Admin, SCAN\nadmin\n\n# a comment\nscan')
  assert.equal(errors.length, 0)
  assert.deepEqual(permissions, ['admin', 'scan'])
})

test('parsePermissions accepts comma AND newline separated tokens', () => {
  const { permissions } = parsePermissions('admin\ngateadmin,provisioning')
  assert.deepEqual(permissions, ['admin', 'gateadmin', 'provisioning'])
})

test('parsePermissions flags an unknown token but keeps parsing the rest', () => {
  const { permissions, errors } = parsePermissions('admin, nope, scan')
  assert.deepEqual(permissions, ['admin', 'scan'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'UNKNOWN_PERMISSION')
})

test('parsePermissions returns nothing for blank input', () => {
  const { permissions, errors } = parsePermissions('')
  assert.equal(permissions.length, 0)
  assert.equal(errors.length, 0)
})

// --- groupsFromGroupsAction ----------------------------------------------------

test('groupsFromGroupsAction unwraps the verified live api/permissions/groups shape', () => {
  const map = groupsFromGroupsAction({
    paging: { pageIndex: 1, pageSize: 100, total: 3 },
    groups: [
      { name: 'Anyone', permissions: [] },
      { id: 'AU-1', name: 'sonar-administrators', description: 'System administrators', permissions: ['admin', 'gateadmin'], managed: false },
      { id: 'AU-2', name: 'sonar-users', description: 'Any authenticated user', permissions: [], managed: true },
    ],
  })
  assert.deepEqual(map.get('Anyone'), [])
  assert.deepEqual(map.get('sonar-administrators'), ['admin', 'gateadmin'])
  assert.deepEqual(map.get('sonar-users'), [])
  assert.equal(map.size, 3)
})

test('groupsFromGroupsAction returns an empty map for a malformed payload', () => {
  assert.equal(groupsFromGroupsAction({}).size, 0)
  assert.equal(groupsFromGroupsAction(null).size, 0)
})

// --- reconcile -----------------------------------------------------------------

test('reconcile computes add/remove for overlapping permission lists', () => {
  const { toAdd, toRemove } = reconcile(['admin', 'scan'], ['admin', 'gateadmin'])
  assert.deepEqual(toAdd.sort(), ['scan'])
  assert.deepEqual(toRemove.sort(), ['gateadmin'])
})

test('reconcile computes add/remove for disjoint permission lists', () => {
  const { toAdd, toRemove } = reconcile(['admin'], ['scan'])
  assert.deepEqual(toAdd, ['admin'])
  assert.deepEqual(toRemove, ['scan'])
})

test('reconcile is a no-op for identical permission lists', () => {
  const { toAdd, toRemove } = reconcile(['admin', 'scan'], ['scan', 'admin'])
  assert.equal(toAdd.length, 0)
  assert.equal(toRemove.length, 0)
})

// --- fetchAllGroupPerms (paginated, network-free via an injected fetcher) -----

test('fetchAllGroupPerms stops after a single short page', async () => {
  let calls = 0
  const map = await fetchAllGroupPerms(async (page, pageSize): Promise<GroupsActionPage> => {
    calls++
    return { paging: { pageIndex: page, pageSize, total: 2 }, groups: [{ name: 'Anyone', permissions: [] }, { name: 'devs', permissions: ['scan'] }] }
  })
  assert.equal(calls, 1)
  assert.deepEqual(map.get('devs'), ['scan'])
})

test('fetchAllGroupPerms pages until the total is exhausted', async () => {
  // fetchAllGroupPerms always requests its own fixed page size (100) — the mock below
  // honors whatever pageSize it is called with, so this exercises the real page-size.
  const total = 250
  let calls = 0
  const map = await fetchAllGroupPerms(async (page, pageSize): Promise<GroupsActionPage> => {
    calls++
    const start = (page - 1) * pageSize
    const count = Math.max(0, Math.min(pageSize, total - start))
    const groups = Array.from({ length: count }, (_, idx) => ({ name: `g${start + idx + 1}`, permissions: ['scan'] }))
    return { paging: { pageIndex: page, pageSize, total }, groups }
  })
  assert.equal(calls, 3) // e.g. 100 + 100 + 50 at the real page size
  assert.equal(map.size, total)
  assert.deepEqual(map.get('g1'), ['scan'])
  assert.deepEqual(map.get(`g${total}`), ['scan'])
})
