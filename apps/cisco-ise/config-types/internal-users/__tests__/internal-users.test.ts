import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, toInternalUserBody, stripSecrets, MAX_USERNAME_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { InternalUser } from '../../../lib/iseApi'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.username ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { username: 'jdoe', password: 'S3cr3t!', email: 'jdoe@example.com' }

test('validate rejects a missing username', async () => {
  const res = await validate(ctxOf([{ ...good, username: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_USERNAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a username over the ERS length limit', async () => {
  const res = await validate(ctxOf([{ ...good, username: 'a'.repeat(MAX_USERNAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'USERNAME_TOO_LONG'))
})

test('validate rejects a malformed email', async () => {
  const res = await validate(ctxOf([{ ...good, email: 'not-an-email' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EMAIL'))
})

test('validate warns when the password is blank', async () => {
  const res = await validate(ctxOf([{ ...good, password: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PASSWORD_BLANK'))
})

test('validate warns on a duplicate username', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_USERNAME'))
})

test('validate accepts a well-formed user', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([good]))
  assert.equal(specs.length, 1)
  assert.equal(specs[0].username, 'jdoe')
})

test('toInternalUserBody omits password/enablePassword when blank', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { username: 'jdoe' } })
  const body = toInternalUserBody(spec, '')
  assert.equal(body.password, undefined)
  assert.equal(body.enablePassword, undefined)
  assert.equal(body.identityGroups, undefined)
})

test('toInternalUserBody includes password and resolved identity group ids when provided', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: good })
  const body = toInternalUserBody(spec, 'id-1,id-2')
  assert.equal(body.password, 'S3cr3t!')
  assert.equal(body.identityGroups, 'id-1,id-2')
})

test('stripSecrets removes password and enablePassword from a live user snapshot', () => {
  const user: InternalUser = { id: '1', name: 'jdoe', password: 'leaked', enablePassword: 'also-leaked' }
  const stripped = stripSecrets(user)
  assert.equal((stripped as InternalUser).password, undefined)
  assert.equal((stripped as InternalUser).enablePassword, undefined)
  assert.equal(stripped.name, 'jdoe')
})
