import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, isValidExpires, toUserCreateBody, toUserUpdateBody, snapshotUser, userKey, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `user-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validUser = { name: 'automation-auditor', password: 'ChangeMe!23', descr: 'Managed by Veltrix', priv: [] }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a username', async () => {
  const res = await validate(ctxOf([{ ...validUser, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a username over the 32-character limit', async () => {
  const res = await validate(ctxOf([{ ...validUser, name: 'a'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects an invalid character in the username', async () => {
  const res = await validate(ctxOf([{ ...validUser, name: 'bad user!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a duplicate username', async () => {
  const res = await validate(ctxOf([validUser, validUser]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate warns (does not error) on a blank password', async () => {
  const res = await validate(ctxOf([{ ...validUser, password: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_PASSWORD_SET'))
})

test('validate rejects a malformed expires date', async () => {
  const res = await validate(ctxOf([{ ...validUser, expires: '2026-12-31' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXPIRES'))
})

test('validate accepts a well-formed expires date', async () => {
  const res = await validate(ctxOf([{ ...validUser, expires: '12/31/2026' }]))
  assert.equal(res.errors.some((e) => e.code === 'INVALID_EXPIRES'), false)
})

test('validate accepts a well-formed user', async () => {
  const res = await validate(ctxOf([validUser]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validUser, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('isValidExpires accepts MM/DD/YYYY and an empty string, rejects other formats', () => {
  assert.equal(isValidExpires(''), true)
  assert.equal(isValidExpires('1/1/2027'), true)
  assert.equal(isValidExpires('12/31/2026'), true)
  assert.equal(isValidExpires('2026/12/31'), false)
  assert.equal(isValidExpires('13/01/2026'), false)
})

test('userKey is case-sensitive (no folding)', () => {
  assert.notEqual(userKey('Admin'), userKey('admin'))
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validUser, { ...validUser, name: 'other' }]))
  assert.equal(specs.length, 2)
})

test('toUserCreateBody always includes password', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validUser })
  const body = toUserCreateBody(spec)
  assert.equal(body.password, 'ChangeMe!23')
})

test('toUserUpdateBody omits password when blank, keeps it when set', () => {
  const blankSpec = specFromItem({ id: 'i', name: 'x', fields: { ...validUser, password: '' } })
  assert.equal('password' in toUserUpdateBody(blankSpec), false)

  const setSpec = specFromItem({ id: 'i', name: 'x', fields: validUser })
  assert.equal(toUserUpdateBody(setSpec).password, 'ChangeMe!23')
})

test('snapshotUser never includes id or password', () => {
  const snap = snapshotUser({ id: 4, name: 'automation-auditor', password: 'irrelevant-hash', disabled: false, descr: 'x' }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal('password' in snap, false)
  assert.equal(snap.name, 'automation-auditor')
})
