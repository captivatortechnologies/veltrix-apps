import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  buildPatchBody,
  managedFieldsToPatchBody,
  readManagedFields,
  sameManagedFields,
  snapshotManagedFields,
  UUID_PATTERN,
  type AuthentikSAMLProvider,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const AUTHZ_FLOW = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
const INVAL_FLOW = 'b2c3d4e5-f6a7-4890-b123-456789abcdef'

const good = {
  name: 'Concur SAML',
  authorization_flow: AUTHZ_FLOW,
  invalidation_flow: INVAL_FLOW,
  acs_url: 'https://concur.example.com/saml/acs',
  audience: 'https://concur.example.com',
  sp_binding: 'post',
  sign_assertion: true,
  sign_response: false,
  property_mappings: [],
}

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

test('validate rejects a missing acs_url', async () => {
  const res = await validate(ctxOf([{ ...good, acs_url: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACS_URL'))
})

test('validate rejects an unknown sp_binding', async () => {
  const res = await validate(ctxOf([{ ...good, sp_binding: 'artifact' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SP_BINDING'))
})

test('validate rejects a non-UUID authorization_flow', async () => {
  const res = await validate(ctxOf([{ ...good, authorization_flow: 'nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_AUTHORIZATION_FLOW'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a fully populated provider', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('UUID_PATTERN matches a v4-shaped UUID', () => {
  assert.equal(UUID_PATTERN.test(AUTHZ_FLOW), true)
  assert.equal(UUID_PATTERN.test('nope'), false)
})

test('readManagedFields defaults an invalid sp_binding to redirect', () => {
  const managed = readManagedFields({ ...good, sp_binding: 'weird' })
  assert.equal(managed.spBinding, 'redirect')
})

test('buildCreateBody omits property_mappings when empty', () => {
  const body = buildCreateBody(good) as Record<string, unknown>
  assert.equal('property_mappings' in body, false)
  assert.equal(body.acs_url, 'https://concur.example.com/saml/acs')
  assert.equal(body.sign_assertion, true)
})

test('buildPatchBody reflects declared fields', () => {
  const body = buildPatchBody(good) as Record<string, unknown>
  assert.equal(body.sp_binding, 'post')
})

test('snapshotManagedFields reads a live provider', () => {
  const live: AuthentikSAMLProvider = {
    pk: 3,
    name: 'Concur SAML',
    authorization_flow: AUTHZ_FLOW,
    invalidation_flow: INVAL_FLOW,
    acs_url: 'https://concur.example.com/saml/acs',
    audience: 'https://concur.example.com',
    sp_binding: 'post',
    sign_assertion: true,
    sign_response: false,
    property_mappings: [],
  }
  const snap = snapshotManagedFields(live)
  assert.equal(snap.spBinding, 'post')
  assert.equal(snap.signAssertion, true)
})

test('sameManagedFields detects a changed acs_url', () => {
  const expected = readManagedFields(good)
  const actual = snapshotManagedFields({ ...good, acs_url: 'https://changed.example.com/acs' } as AuthentikSAMLProvider)
  assert.equal(sameManagedFields(expected, actual), false)
})

test('managedFieldsToPatchBody round-trips a captured snapshot', () => {
  const managed = readManagedFields(good)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.equal(body.acs_url, 'https://concur.example.com/saml/acs')
})
