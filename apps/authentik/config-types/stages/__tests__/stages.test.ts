import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  managedFieldsToPatchBody,
  readManagedFields,
  readStageType,
  sameManagedFields,
  snapshotManagedFields,
  type AuthentikStage,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const idGood = { name: 'Default Identification', type: 'identification', user_fields: ['email', 'username'] }
const pwGood = { name: 'Default Password', type: 'password', backends: ['authentik.core.auth.InbuiltBackend'] }
const mfaGood = { name: 'Default MFA', type: 'authenticator-validate', device_classes: ['totp', 'webauthn'], not_configured_action: 'configure' }
const loginGood = { name: 'Default Login', type: 'user-login', session_duration: 'seconds=0' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...idGood, type: 'captcha' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects an invalid user_fields entry', async () => {
  const res = await validate(ctxOf([{ ...idGood, user_fields: ['phone'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_USER_FIELD'))
})

test('validate requires at least one backend for Type = Password', async () => {
  const res = await validate(ctxOf([{ ...pwGood, backends: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_BACKENDS'))
})

test('validate rejects an unknown backend', async () => {
  const res = await validate(ctxOf([{ ...pwGood, backends: ['not.a.backend'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_BACKEND'))
})

test('validate rejects an unknown device class', async () => {
  const res = await validate(ctxOf([{ ...mfaGood, device_classes: ['fingerprint'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DEVICE_CLASS'))
})

test('validate accepts all four fully populated stage types', async () => {
  const res = await validate(ctxOf([idGood, pwGood, mfaGood, loginGood]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('readStageType defaults an invalid/blank type to identification', () => {
  assert.equal(readStageType('bogus'), 'identification')
  assert.equal(readStageType('user-login'), 'user-login')
})

test('buildCreateBody for identification only sends identification fields', () => {
  const body = buildCreateBody(idGood) as Record<string, unknown>
  assert.deepEqual(body.user_fields, ['email', 'username'])
  assert.equal('backends' in body, false)
})

test('buildCreateBody for password only sends password fields', () => {
  const body = buildCreateBody(pwGood) as Record<string, unknown>
  assert.deepEqual(body.backends, ['authentik.core.auth.InbuiltBackend'])
  assert.equal('device_classes' in body, false)
})

test('buildCreateBody for authenticator-validate only sends its fields', () => {
  const body = buildCreateBody(mfaGood) as Record<string, unknown>
  assert.deepEqual(body.device_classes, ['totp', 'webauthn'])
  assert.equal(body.not_configured_action, 'configure')
  assert.equal('backends' in body, false)
})

test('buildCreateBody for user-login only sends its fields', () => {
  const body = buildCreateBody(loginGood) as Record<string, unknown>
  assert.equal(body.session_duration, 'seconds=0')
  assert.equal('backends' in body, false)
})

test('snapshotManagedFields + sameManagedFields agree for an unchanged password stage', () => {
  const expected = readManagedFields(pwGood)
  const live: AuthentikStage = { pk: 'uuid-1', name: 'Default Password', backends: ['authentik.core.auth.InbuiltBackend'] }
  const actual = snapshotManagedFields(live, 'password')
  assert.equal(sameManagedFields(expected, actual), true)
})

test('sameManagedFields flags a changed backend set', () => {
  const expected = readManagedFields(pwGood)
  const actual = snapshotManagedFields({ pk: 'uuid-1', name: 'Default Password', backends: ['authentik.sources.ldap.auth.LDAPBackend'] }, 'password')
  assert.equal(sameManagedFields(expected, actual), false)
})

test('managedFieldsToPatchBody round-trips a captured identification snapshot', () => {
  const managed = readManagedFields(idGood)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.deepEqual(body.user_fields, ['email', 'username'])
})
