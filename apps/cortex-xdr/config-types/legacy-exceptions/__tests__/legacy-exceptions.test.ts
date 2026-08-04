import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildLegacyExceptionBody, findException, exceptionsFromReply, isValidConditionsJson, normalizeName } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cortex XDR REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (identity matching + body building) — both network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Allow internal build agent',
  platform: 'windows',
  module: 12,
  status: 'enabled',
  scope: 'global',
  conditions: '{"path":"C:\\\\build\\\\agent.exe"}',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed legacy exception', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown platform', async () => {
  const res = await validate(ctxOf([{ ...good, platform: 'solaris' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PLATFORM'))
})

test('validate rejects a non-positive module id', async () => {
  const res = await validate(ctxOf([{ ...good, module: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MODULE'))
})

test('validate rejects an unknown status', async () => {
  const res = await validate(ctxOf([{ ...good, status: 'pending' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STATUS'))
})

test('validate requires profile_ids when scope is profile', async () => {
  const res = await validate(ctxOf([{ ...good, scope: 'profile', profile_ids: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_PROFILE_IDS'))
})

test('validate accepts scope profile with profile_ids supplied', async () => {
  const res = await validate(ctxOf([{ ...good, scope: 'profile', profile_ids: [1, 2] }]))
  assert.equal(res.valid, true)
})

test('validate rejects invalid conditions JSON', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONDITIONS_JSON'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('buildLegacyExceptionBody parses conditions JSON and defaults status/scope', () => {
  const body = buildLegacyExceptionBody({ name: 'X', platform: 'linux', module: 3, conditions: '{"hash":"abc"}' })
  assert.equal(body.status, 'enabled')
  assert.equal(body.scope, 'global')
  assert.deepEqual(body.conditions, { hash: 'abc' })
})

test('buildLegacyExceptionBody throws when conditions is blank', () => {
  assert.throws(() => buildLegacyExceptionBody({ name: 'X', platform: 'linux', module: 3, conditions: '' }))
})

test('isValidConditionsJson rejects blank and malformed JSON', () => {
  assert.equal(isValidConditionsJson(''), false)
  assert.equal(isValidConditionsJson('{"a":1}'), true)
  assert.equal(isValidConditionsJson('{a:1}'), false)
})

test('findException matches case-insensitively on rule_name', () => {
  const live = [{ rule_name: 'ALLOW INTERNAL BUILD AGENT', id: 'exc-1' }]
  const match = findException(live, 'allow internal build agent')
  assert.ok(match)
  assert.equal(match?.id, 'exc-1')
})

test('exceptionsFromReply unwraps { DATA: [...] } and bare arrays', () => {
  assert.equal(exceptionsFromReply([{ rule_name: 'a' }]).length, 1)
  assert.equal(exceptionsFromReply({ DATA: [{ rule_name: 'b' }, { rule_name: 'c' }] }).length, 2)
  assert.equal(exceptionsFromReply(null).length, 0)
})

test('normalizeName trims and lowercases', () => {
  assert.equal(normalizeName('  Allow It  '), 'allow it')
})
