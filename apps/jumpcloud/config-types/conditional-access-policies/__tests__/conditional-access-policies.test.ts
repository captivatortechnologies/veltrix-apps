import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractConditionalAccessPolicySpecs,
  parseJsonObjectField,
  normalizeBool,
  buildAuthnPolicyBody,
  findAuthnPolicyByName,
  priorFieldsOf,
  type JumpCloudAuthnPolicy,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = {
  name: 'Restrict Admin Portal to Corp IPs',
  type: 'admin_portal',
  action: 'allow',
  targetsRaw: '{"users":{"inclusions":["ALL"]}}',
  conditionsRaw: '{"ipAddressIn":["609f...ip-list-id"]}',
}

// --- validate -----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing/invalid type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TYPE'))

  const res2 = await validate(ctxOf([{ ...good, type: 'not_a_type' }]))
  assert.equal(res2.valid, false)
  assert.ok(res2.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects an invalid action', async () => {
  const res = await validate(ctxOf([{ ...good, action: 'block' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})

test('validate rejects malformed targets/conditions JSON', async () => {
  const res = await validate(ctxOf([{ ...good, targetsRaw: '{ bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TARGETS'))

  const res2 = await validate(ctxOf([{ ...good, conditionsRaw: '[1,2]' }]))
  assert.equal(res2.valid, false)
  assert.ok(res2.errors.some((e) => e.code === 'INVALID_CONDITIONS'))
})

test('validate warns on empty targets', async () => {
  const res = await validate(ctxOf([{ ...good, targetsRaw: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_TARGETS'))
})

test('validate errors on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers ----------------------------------------------------------

test('normalizeBool honours explicit true/false and falls back otherwise', () => {
  assert.equal(normalizeBool(undefined, false), false)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('false'), false)
})

test('parseJsonObjectField parses a valid object and rejects non-object JSON', () => {
  assert.deepEqual(parseJsonObjectField('', 'targets').value, {})
  const ok = parseJsonObjectField('{"a":1}', 'targets')
  assert.equal(ok.error, undefined)
  assert.deepEqual(ok.value, { a: 1 })
  assert.ok(parseJsonObjectField('[1,2]', 'targets').error)
  assert.ok(parseJsonObjectField('{ bad', 'targets').error)
})

test('extractConditionalAccessPolicySpecs trims fields and defaults action to allow', () => {
  const [spec] = extractConditionalAccessPolicySpecs(canvasOf([{ name: '  P  ', type: 'ldap' }]))
  assert.equal(spec.name, 'P')
  assert.equal(spec.type, 'ldap')
  assert.equal(spec.action, 'allow')
  assert.equal(spec.itemId, 'i0')
})

test('buildAuthnPolicyBody includes type only when requested', () => {
  const spec = { name: 'P', description: '', type: 'user_portal', disabled: false, monitorOnly: false, action: 'allow', mfaRequired: true, targetsRaw: '', conditionsRaw: '' }
  const withType = buildAuthnPolicyBody(spec, {}, {}, { includeType: true })
  assert.equal(withType.type, 'user_portal')
  assert.deepEqual(withType.effect, { action: 'allow', obligations: { mfa: { required: true } } })

  const withoutType = buildAuthnPolicyBody(spec, {}, {}, { includeType: false })
  assert.equal('type' in withoutType, false)
})

test('findAuthnPolicyByName matches case-insensitively', () => {
  const policies: JumpCloudAuthnPolicy[] = [{ id: 'a', name: 'Admin Portal IP Restriction' }]
  assert.equal(findAuthnPolicyByName(policies, 'admin portal ip restriction')?.id, 'a')
  assert.equal(findAuthnPolicyByName(policies, 'MISSING'), null)
})

test('priorFieldsOf captures the managed fields for rollback', () => {
  const prior = priorFieldsOf({ id: 'a', name: 'P', disabled: true, effect: { action: 'deny' }, targets: { users: { inclusions: ['ALL'] } } })
  assert.equal(prior.name, 'P')
  assert.equal(prior.disabled, true)
  assert.deepEqual(prior.effect, { action: 'deny' })
  assert.deepEqual(prior.targets, { users: { inclusions: ['ALL'] } })
  assert.deepEqual(prior.conditions, {})
})
