import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildProfileCreateBody,
  buildProfileUpdateBody,
  toProfileUpdate,
  findProfile,
  profileId,
  parsePermissions,
  profilesFromList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the TheHive REST API (node:https inside
 * thehiveApi), impractical to mock here. Tests cover validate.ts and the pure
 * network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'threat-intel-analyst', permissions: 'manageCase, manageAlert/create\nmanageObservable' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate warns when the name matches an immutable built-in profile', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'org-admin' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'IMMUTABLE_PROFILE'))
})

test('validate does not warn for the editable "analyst" built-in', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'analyst' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'IMMUTABLE_PROFILE'))
})

test('validate accepts a good profile', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('parsePermissions splits on newlines and commas and dedupes', () => {
  assert.deepEqual(parsePermissions('manageCase, manageAlert/create\nmanageCase'), ['manageCase', 'manageAlert/create'])
  assert.deepEqual(parsePermissions(undefined), [])
})

test('buildProfileCreateBody carries name and parsed permissions', () => {
  const body = buildProfileCreateBody(good)
  assert.equal(body.name, 'threat-intel-analyst')
  assert.deepEqual(body.permissions, ['manageCase', 'manageAlert/create', 'manageObservable'])
})

test('buildProfileUpdateBody omits name', () => {
  const body = buildProfileUpdateBody(good)
  assert.ok(!('name' in body))
  assert.deepEqual(body.permissions, ['manageCase', 'manageAlert/create', 'manageObservable'])
})

test('toProfileUpdate maps a live profile to its permission list', () => {
  assert.deepEqual(toProfileUpdate({ _id: 'abc', name: 'x', permissions: ['manageCase'] }), { permissions: ['manageCase'] })
  assert.deepEqual(toProfileUpdate({ _id: 'abc', name: 'x' }), { permissions: [] })
})

test('findProfile matches by exact name; profileId prefers _id then id', () => {
  const live = [{ _id: 'abc', name: 'analyst' }, { id: 5, name: 'read-only' }]
  assert.equal(profileId(findProfile(live, 'analyst')), 'abc')
  assert.equal(profileId(findProfile(live, 'read-only')), '5')
  assert.equal(findProfile(live, 'nope'), null)
})

test('profilesFromList unwraps arrays and wrapped rows', () => {
  assert.equal(profilesFromList([{ name: 'a' }]).length, 1)
  assert.equal(profilesFromList({ data: [{ name: 'a' }] }).length, 1)
  assert.equal(profilesFromList(null).length, 0)
})
