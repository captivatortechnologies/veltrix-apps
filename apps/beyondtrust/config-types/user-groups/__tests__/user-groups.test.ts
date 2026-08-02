import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildCreateBody, findUserGroup, groupIdOf, groupIdentity, groupNameOf, groupsFromList, toBool } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the BeyondInsight REST API via node:https inside
 * beyondtrustApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers (identity, list-unwrap, create-body, boolean
 * coercion), which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.groupName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { groupName: 'Security Admins', description: 'Runs Password Safe', isActive: true }

test('validate rejects a missing group name', async () => {
  const res = await validate(ctxOf([{ ...good, groupName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_GROUP_NAME'))
})

test('validate rejects a missing description (required for BeyondInsight groups)', async () => {
  const res = await validate(ctxOf([{ ...good, description: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESCRIPTION'))
})

test('validate rejects an over-long group name', async () => {
  const res = await validate(ctxOf([{ ...good, groupName: 'a'.repeat(201) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'GROUP_NAME_TOO_LONG'))
})

test('validate rejects an over-long description', async () => {
  const res = await validate(ctxOf([{ ...good, description: 'a'.repeat(256) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('validate warns on a duplicate group name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, groupName: 'security admins', description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_GROUP'))
})

test('validate accepts a good group', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('toBool coerces truthy/falsy strings and defaults blanks', () => {
  assert.equal(toBool(true), true)
  assert.equal(toBool(false), false)
  assert.equal(toBool('yes'), true)
  assert.equal(toBool('off'), false)
  assert.equal(toBool('', true), true)
  assert.equal(toBool('', false), false)
  assert.equal(toBool(undefined, true), true)
})

test('groupsFromList unwraps arrays and paginated containers', () => {
  assert.equal(groupsFromList([{ Name: 'a' }]).length, 1)
  assert.equal(groupsFromList({ Data: [{ Name: 'a' }, { Name: 'b' }] }).length, 2)
  assert.equal(groupsFromList(null).length, 0)
})

test('findUserGroup matches on name, case-insensitively', () => {
  const live = [
    { GroupID: 10, Name: 'Security Admins' },
    { UserGroupID: 11, GroupName: 'Auditors' },
  ]
  assert.equal(groupIdOf(findUserGroup(live, 'security admins')!), 10)
  assert.equal(groupIdOf(findUserGroup(live, 'AUDITORS')!), 11)
  assert.equal(findUserGroup(live, 'Nope'), null)
})

test('groupIdOf and groupNameOf tolerate response casing variants', () => {
  assert.equal(groupIdOf({ GroupID: 1 }), 1)
  assert.equal(groupIdOf({ UserGroupID: 2 }), 2)
  assert.equal(groupIdOf({ ID: 3 }), 3)
  assert.equal(groupIdOf({}), null)
  assert.equal(groupNameOf({ Name: 'A' }), 'A')
  assert.equal(groupNameOf({ GroupName: 'B' }), 'B')
})

test('groupIdentity is stable across casing and whitespace', () => {
  assert.equal(groupIdentity('  Admins '), groupIdentity('admins'))
})

test('buildCreateBody always sends a BeyondInsight group with the required fields', () => {
  assert.deepEqual(buildCreateBody({ groupName: 'Admins', description: 'desc', isActive: true }), {
    groupType: 'BeyondInsight',
    groupName: 'Admins',
    description: 'desc',
    isActive: true,
  })
  // Blank isActive defaults to active.
  assert.deepEqual(buildCreateBody({ groupName: 'Admins', description: 'desc', isActive: '' }), {
    groupType: 'BeyondInsight',
    groupName: 'Admins',
    description: 'desc',
    isActive: true,
  })
})
