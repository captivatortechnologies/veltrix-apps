import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildOwnershipTypePost,
  buildOwnershipTypeUpdate,
  ownershipTypeMatches,
  findOwnershipType,
  intOrUndefined,
  type RunzeroOwnershipType,
} from '../_shared'
import { coerceList } from '../../../lib/runzeroApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift/health hit the runZero console API via fetch, which is impractical to
 * mock here. Tests focus on validate.ts and the network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Asset Owner', order: 1, hidden: false }

// --- validate -------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid ownership type', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, order: 2 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers ------------------------------------------------------

test('intOrUndefined coerces blanks to undefined', () => {
  assert.equal(intOrUndefined(''), undefined)
  assert.equal(intOrUndefined(null), undefined)
  assert.equal(intOrUndefined(3), 3)
  assert.equal(intOrUndefined('7'), 7)
})

test('buildOwnershipTypePost maps fields and omits blank optional keys', () => {
  const post = buildOwnershipTypePost({ name: ' Asset Owner ', order: 1, hidden: true })
  assert.deepEqual(post, { name: 'Asset Owner', order: 1, hidden: true })
  const bare = buildOwnershipTypePost({ name: 'Bare' })
  assert.deepEqual(bare, { name: 'Bare' })
})

test('buildOwnershipTypeUpdate layers declared fields over the existing object, preserving id', () => {
  const existing: RunzeroOwnershipType = { id: 'ot-1', name: 'Asset Owner', order: 1, hidden: false, reference: 3 }
  const upd = buildOwnershipTypeUpdate(existing, { name: 'Asset Owner', order: 2, hidden: true })
  assert.equal(upd.id, 'ot-1')
  assert.equal(upd.order, 2)
  assert.equal(upd.hidden, true)
  assert.equal(upd.reference, 3)
})

test('ownershipTypeMatches detects a no-op vs a real change', () => {
  const existing: RunzeroOwnershipType = { id: 'ot-1', name: 'Asset Owner', order: 1, hidden: false }
  assert.equal(ownershipTypeMatches(existing, { order: 1, hidden: false }), true)
  assert.equal(ownershipTypeMatches(existing, { order: 2, hidden: false }), false)
  assert.equal(ownershipTypeMatches(existing, { hidden: true }), false)
})

test('findOwnershipType matches by name case-insensitively', () => {
  const types = [{ id: '1', name: 'Asset Owner' }, { id: '2', name: 'Security Contact' }]
  assert.equal(findOwnershipType(types, 'asset owner')?.id, '1')
  assert.equal(findOwnershipType(types, 'SECURITY CONTACT')?.id, '2')
  assert.equal(findOwnershipType(types, 'nope'), null)
})

test('coerceList accepts a bare array and a { data } envelope', () => {
  assert.equal(coerceList([{ id: '1' }]).length, 1)
  assert.equal(coerceList({ data: [{ id: '1' }, { id: '2' }] }).length, 2)
  assert.equal(coerceList(null).length, 0)
})
