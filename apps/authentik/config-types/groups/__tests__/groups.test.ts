import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  buildPatchBody,
  managedFieldsToPatchBody,
  normalizeBool,
  readAttributes,
  readManagedFields,
  sameAttributes,
  sameManagedFields,
  snapshotManagedFields,
  UUID_PATTERN,
  type AuthentikGroup,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const PARENT_UUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'

const good = {
  name: 'Platform Admins',
  is_superuser: false,
  parent: '',
  attributes: { team: 'platform' },
}

// --- validate ----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a non-UUID parent', async () => {
  const res = await validate(ctxOf([{ ...good, parent: 'not-a-uuid' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PARENT'))
})

test('validate accepts a valid UUID parent', async () => {
  const res = await validate(ctxOf([{ ...good, parent: PARENT_UUID }]))
  assert.equal(res.valid, true)
})

test('validate warns on unparseable string attributes', async () => {
  const res = await validate(ctxOf([{ ...good, attributes: 'not key value pairs at all' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNPARSEABLE_ATTRIBUTES'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a fully populated group', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test('UUID_PATTERN matches a v4-shaped UUID and rejects garbage', () => {
  assert.equal(UUID_PATTERN.test(PARENT_UUID), true)
  assert.equal(UUID_PATTERN.test('nope'), false)
})

test('normalizeBool coerces strings and falls back', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool('1'), true)
  assert.equal(normalizeBool(undefined, true), true)
})

test('readAttributes accepts an object, array-of-pairs, or "k=v" lines', () => {
  assert.deepEqual(readAttributes({ team: 'platform' }), { team: 'platform' })
  assert.deepEqual(readAttributes([{ key: 'team', value: 'platform' }]), { team: 'platform' })
  assert.deepEqual(readAttributes('team=platform\ntier=1'), { team: 'platform', tier: '1' })
  assert.deepEqual(readAttributes(''), {})
})

test('sameAttributes compares keys and values', () => {
  assert.equal(sameAttributes({ a: '1' }, { a: '1' }), true)
  assert.equal(sameAttributes({ a: '1' }, { a: '2' }), false)
  assert.equal(sameAttributes({ a: '1' }, { a: '1', b: '2' }), false)
})

test('readManagedFields trims and reads attributes', () => {
  const managed = readManagedFields({ ...good, name: '  Platform Admins  ' })
  assert.equal(managed.name, 'Platform Admins')
  assert.equal(managed.isSuperuser, false)
  assert.deepEqual(managed.attributes, { team: 'platform' })
})

test('buildCreateBody omits parents when no parent is declared', () => {
  const body = buildCreateBody(good) as Record<string, unknown>
  assert.equal('parents' in body, false)
  assert.equal(body.name, 'Platform Admins')
})

test('buildPatchBody sends a single-element parents array when declared', () => {
  const body = buildPatchBody({ ...good, parent: PARENT_UUID }) as Record<string, unknown>
  assert.deepEqual(body.parents, [PARENT_UUID])
})

test('snapshotManagedFields reads the first live parent and coerces attribute values', () => {
  const live: AuthentikGroup = {
    pk: 'grp-1',
    name: 'Platform Admins',
    is_superuser: true,
    parents: [PARENT_UUID, 'b2c3d4e5-f6a7-4890-b123-456789abcdef'],
    attributes: { team: 'platform', headcount: 5 },
  }
  const snap = snapshotManagedFields(live)
  assert.equal(snap.isSuperuser, true)
  assert.equal(snap.parent, PARENT_UUID)
  assert.deepEqual(snap.attributes, { team: 'platform', headcount: '5' })
})

test('sameManagedFields ignores a live parent when none was declared', () => {
  const expected = readManagedFields(good)
  const actual = snapshotManagedFields({ name: 'Platform Admins', is_superuser: false, parents: [PARENT_UUID], attributes: { team: 'platform' } })
  assert.equal(sameManagedFields(expected, actual), true)
})

test('sameManagedFields flags an is_superuser change', () => {
  const expected = readManagedFields(good)
  const actual = snapshotManagedFields({ name: 'Platform Admins', is_superuser: true, attributes: { team: 'platform' } })
  assert.equal(sameManagedFields(expected, actual), false)
})

test('managedFieldsToPatchBody round-trips a captured snapshot', () => {
  const managed = readManagedFields({ ...good, parent: PARENT_UUID })
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.deepEqual(body.parents, [PARENT_UUID])
  assert.equal(body.name, 'Platform Admins')
})
