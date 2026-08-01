import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildGroupBody,
  buildGroupUpdateBody,
  normalizeMembers,
  parseList,
  findGroup,
  groupsFromList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The mutating handlers apply over the Vectra REST API via node:https inside
 * vectraApi, which is impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers (body building, member normalization, identity matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Crown Jewels',
  type: 'host',
  description: 'High-value hosts',
  members: '3345, 3410',
}

// --- validate ---------------------------------------------------------------

test('validate accepts a good host group', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown group type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'made-up' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects a non-numeric host member', async () => {
  const res = await validate(ctxOf([{ ...good, members: '3345, not-a-number' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NON_NUMERIC_MEMBER'))
})

test('validate rejects a malformed IP member on an ip group', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'ip', members: '10.1.1.0/24, 999.1.1.1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_IP_MEMBER'))
})

test('validate accepts a valid ip group', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'ip', members: '10.1.1.0/24, 10.2.0.5' }]))
  assert.equal(res.valid, true)
})

test('validate accepts a domain group', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'domain', members: 'evil.example.com' }]))
  assert.equal(res.valid, true)
})

test('validate warns on an empty-membership group', async () => {
  const res = await validate(ctxOf([{ ...good, members: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_MEMBERS'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, members: '9999' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('parseList splits, trims and de-duplicates', () => {
  assert.deepEqual(parseList('a, b  a , c'), ['a', 'b', 'c'])
  assert.deepEqual(parseList(''), [])
})

test('buildGroupBody coerces host members to numeric ids and carries type', () => {
  const body = buildGroupBody(good)
  assert.equal(body.type, 'host')
  assert.deepEqual(body.members, [3345, 3410])
})

test('buildGroupBody keeps string members for non-host types', () => {
  const body = buildGroupBody({ ...good, type: 'domain', members: 'a.com, b.com' })
  assert.deepEqual(body.members, ['a.com', 'b.com'])
})

test('buildGroupUpdateBody omits type (immutable on update)', () => {
  const body = buildGroupUpdateBody(good)
  assert.equal('type' in body, false)
  assert.equal(body.name, 'Crown Jewels')
  assert.deepEqual(body.members, [3345, 3410])
})

test('normalizeMembers collapses expanded member objects to ids', () => {
  assert.deepEqual(normalizeMembers([{ id: 3345, name: 'h1' }, { id: 3410 }], 'host'), [3345, 3410])
  assert.deepEqual(normalizeMembers([{ name: 'a.com' }, 'b.com'], 'domain'), ['a.com', 'b.com'])
})

test('groupsFromList unwraps the DRF results envelope', () => {
  assert.deepEqual(groupsFromList({ count: 1, results: [{ id: 1 }] }), [{ id: 1 }])
  assert.deepEqual(groupsFromList([{ id: 2 }]), [{ id: 2 }])
  assert.deepEqual(groupsFromList(null), [])
})

test('findGroup matches by name', () => {
  const groups = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]
  assert.equal(findGroup(groups, 'B')?.id, 2)
  assert.equal(findGroup(groups, 'C'), null)
})
