import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { spec, isPasswordType } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the ServiceNow Table API
 * (network) through the shared table-config engine, which is impractical to
 * mock here. Tests focus on validate.ts, the pure spec.buildBody mapping, and
 * isPasswordType — the predicate the password-safety logic in deploy.ts /
 * driftDetect.ts depends on.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'glide.security.session.timeout',
  type: 'integer',
  value: '30',
  description: 'Session idle timeout in minutes',
  isPrivate: false,
  ignoreCache: true,
  readRoles: [],
  writeRoles: ['security_admin'],
}

test('validate accepts a well-formed property', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on an unconventional (non-dotted) name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'sessiontimeout' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNCONVENTIONAL_NAME'))
})

test('validate rejects a name with invalid characters', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'has a space.and.dots' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'float' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate warns on a non-boolean value for a boolean property', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'boolean', value: 'yes' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'INVALID_BOOLEAN_VALUE'))
})

test('validate accepts a valid boolean value', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'boolean', value: 'true' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'INVALID_BOOLEAN_VALUE'))
})

test('validate warns on a non-integer value for an integer property', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'integer', value: 'thirty' }]))
  assert.ok(res.warnings.some((w) => w.code === 'INVALID_INTEGER_VALUE'))
})

test('validate always notices a password-type property', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'password', value: 's3cr3t' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PASSWORD_TYPE_NOTICE'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('isPasswordType recognizes password and password2, and nothing else', () => {
  assert.equal(isPasswordType('password'), true)
  assert.equal(isPasswordType('password2'), true)
  assert.equal(isPasswordType('string'), false)
  assert.equal(isPasswordType(undefined), false)
})

test('spec.buildBody joins read/write role names with commas', () => {
  const body = spec.buildBody({ ...good, readRoles: ['itil', 'security_admin'] })
  assert.equal(body.read_roles, 'itil,security_admin')
  assert.equal(body.write_roles, 'security_admin')
  assert.equal(body.value, '30')
})
