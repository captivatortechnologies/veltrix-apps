import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractMembershipSpecs,
  toMemberList,
  normalizeExclusive,
  buildUserIndex,
  resolveMemberId,
  memberIdOf,
  diffMembers,
  buildMemberOp,
  userIdOf,
  type JumpCloudSystemUser,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/health/drift handlers talk to the JumpCloud API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (network-free).
 */
function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.groupName ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const users: JumpCloudSystemUser[] = [
  { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', email: 'eng@example.com', username: 'eng' },
  { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', email: 'ops@example.com', username: 'ops' },
]

// --- validate -----------------------------------------------------------------

test('validate rejects a missing group name', async () => {
  const res = await validate(ctxOf([{ groupName: '', members: ['eng@example.com'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_GROUP'))
})

test('validate errors on a duplicate group', async () => {
  const res = await validate(ctxOf([{ groupName: 'Eng', members: ['eng'] }, { groupName: 'Eng', members: ['ops'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_GROUP'))
})

test('validate warns on an empty members list', async () => {
  const res = await validate(ctxOf([{ groupName: 'Eng', members: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_MEMBERS'))
})

// --- _shared helpers ----------------------------------------------------------

test('toMemberList splits strings, trims and de-dupes case-insensitively', () => {
  assert.deepEqual(toMemberList('a@x.io, b@x.io\n a@x.io '), ['a@x.io', 'b@x.io'])
  assert.deepEqual(toMemberList(['x', ' x ', 'y']), ['x', 'y'])
})

test('normalizeExclusive defaults to false and honours truthy strings', () => {
  assert.equal(normalizeExclusive(undefined), false)
  assert.equal(normalizeExclusive(true), true)
  assert.equal(normalizeExclusive('true'), true)
  assert.equal(normalizeExclusive('no'), false)
})

test('extractMembershipSpecs reads groupName, members and exclusive', () => {
  const [spec] = extractMembershipSpecs(canvasOf([{ groupName: ' Eng ', members: ['eng', 'ops'], exclusive: true }]))
  assert.equal(spec.groupName, 'Eng')
  assert.deepEqual(spec.members, ['eng', 'ops'])
  assert.equal(spec.exclusive, true)
  assert.equal(spec.itemId, 'i0')
})

test('userIdOf prefers id then _id', () => {
  assert.equal(userIdOf({ id: 'x', _id: 'y' }), 'x')
  assert.equal(userIdOf({ _id: 'y' }), 'y')
  assert.equal(userIdOf({}), '')
})

test('resolveMemberId matches by email, username and raw id', () => {
  const index = buildUserIndex(users)
  assert.equal(resolveMemberId('eng@example.com', index), 'aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(resolveMemberId('OPS', index), 'bbbbbbbbbbbbbbbbbbbbbbbb')
  assert.equal(resolveMemberId('bbbbbbbbbbbbbbbbbbbbbbbb', index), 'bbbbbbbbbbbbbbbbbbbbbbbb')
  assert.equal(resolveMemberId('nobody@example.com', index), null)
  // A well-formed id that is not in the org does not resolve.
  assert.equal(resolveMemberId('cccccccccccccccccccccccc', index), null)
})

test('memberIdOf reads the nested to.id and a flat id', () => {
  assert.equal(memberIdOf({ to: { id: 'x', type: 'user' } }), 'x')
  assert.equal(memberIdOf({ id: 'y', type: 'user' }), 'y')
  assert.equal(memberIdOf({}), '')
})

test('diffMembers is additive by default and exclusive when asked', () => {
  const additive = diffMembers(['a', 'b'], ['b', 'c'], false)
  assert.deepEqual(additive.toAdd, ['c'])
  assert.deepEqual(additive.toRemove, [])

  const exclusive = diffMembers(['a', 'b'], ['b', 'c'], true)
  assert.deepEqual(exclusive.toAdd, ['c'])
  assert.deepEqual(exclusive.toRemove, ['a'])
})

test('buildMemberOp shapes the UserGroupMembersReq body', () => {
  assert.deepEqual(buildMemberOp('add', 'x'), { op: 'add', type: 'user', id: 'x' })
  assert.deepEqual(buildMemberOp('remove', 'y'), { op: 'remove', type: 'user', id: 'y' })
})
