import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, parseRuleDefinition, toRuleBody, ruleEquals } from '../_shared'
import type { PipelineContext, CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Wazuh REST API via
 * node:https inside wazuhApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'wui_admin', ruleDefinition: '{"FIND": {"username": "admin"}}' }

test('validate rejects an empty canvas', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects an invalid name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad name!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects malformed JSON', async () => {
  const res = await validate(ctxOf([{ ...good, ruleDefinition: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULE_JSON'))
})

test('validate rejects a JSON array (must be an object)', async () => {
  const res = await validate(ctxOf([{ ...good, ruleDefinition: '["FIND"]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULE_JSON'))
})

test('validate rejects an empty rule definition', async () => {
  const res = await validate(ctxOf([{ ...good, ruleDefinition: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULE_JSON'))
})

test('validate accepts a well-formed rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('parseRuleDefinition parses nested MATCH/FIND conditions', () => {
  const { rule, error } = parseRuleDefinition('{"OR": [{"FIND": {"username": "a"}}, {"MATCH": {"definition": "b"}}]}')
  assert.equal(error, null)
  assert.deepEqual(rule, { OR: [{ FIND: { username: 'a' } }, { MATCH: { definition: 'b' } }] })
})

test('toRuleBody shapes the wire body', () => {
  const body = toRuleBody(specFromItem({ id: 'i0', name: 'x', fields: good } as CanvasItemSnapshot))
  assert.deepEqual(body, { name: 'wui_admin', rule: { FIND: { username: 'admin' } } })
})

test('ruleEquals is key-order-insensitive', () => {
  assert.equal(ruleEquals({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
  assert.equal(ruleEquals({ a: 1 }, { a: 2 }), false)
  assert.equal(ruleEquals({ FIND: { a: 1, b: 2 } }, { FIND: { b: 2, a: 1 } }), true)
})
