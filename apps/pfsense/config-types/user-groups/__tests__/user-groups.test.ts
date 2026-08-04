import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, groupKey, toUserGroupBody, snapshotUserGroup, MAX_LOCAL_NAME_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `group-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validGroup = { name: 'automation', description: 'CI/CD service accounts', member: ['svc-deploy'], priv: [] }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a name', async () => {
  const res = await validate(ctxOf([{ ...validGroup, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name over the local-scope 16-character limit', async () => {
  const res = await validate(ctxOf([{ ...validGroup, name: 'a'.repeat(MAX_LOCAL_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects an invalid character in the name', async () => {
  const res = await validate(ctxOf([{ ...validGroup, name: 'bad name!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a duplicate name', async () => {
  const res = await validate(ctxOf([validGroup, validGroup]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate warns (does not error) on declared privileges/members (server-verified only)', async () => {
  const res = await validate(ctxOf([{ ...validGroup, priv: ['page-all'] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PRIV_NOT_VERIFIED'))
  assert.ok(res.warnings.some((w) => w.code === 'MEMBER_NOT_VERIFIED'))
})

test('validate accepts a well-formed group with no warnings when no members/privs declared', async () => {
  const res = await validate(ctxOf([{ name: 'empty_group', description: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('specFromItem trims fields and normalizes lists', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { name: '  automation  ', member: ['a', ' b '] } })
  assert.equal(spec.name, 'automation')
  assert.deepEqual(spec.member, ['a', 'b'])
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validGroup, { ...validGroup, name: 'other' }]))
  assert.equal(specs.length, 2)
})

test('groupKey is case-sensitive (no folding)', () => {
  assert.notEqual(groupKey('Automation'), groupKey('automation'))
})

test('toUserGroupBody carries every declared field, no id', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validGroup })
  const body = toUserGroupBody(spec) as Record<string, unknown>
  assert.equal('id' in body, false)
  assert.equal(body.name, 'automation')
  assert.deepEqual(body.member, ['svc-deploy'])
})

test('snapshotUserGroup never includes id', () => {
  const snap = snapshotUserGroup({ id: 3, name: 'automation', description: 'x', member: ['a'], priv: [] }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal(snap.name, 'automation')
})
