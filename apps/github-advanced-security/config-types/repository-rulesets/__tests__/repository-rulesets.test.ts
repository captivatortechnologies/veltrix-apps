import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import {
  desiredFromItem,
  parseJsonArray,
  parseJsonObject,
  buildRulesetBody,
  restoreBody,
  stableStringify,
} from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  owner: 'octo-org',
  repository: 'octo-repo',
  name: 'Protect main',
  target: 'branch',
  enforcement: 'active',
  rules: '[{"type":"pull_request"}]',
  conditions: '{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}}',
  bypass_actors: '[{"actor_id":1,"actor_type":"OrganizationAdmin","bypass_mode":"always"}]',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects missing owner and name', async () => {
  const res = await validate(ctxOf([{ ...good, owner: '', name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_OWNER'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a good repo ruleset', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts an org ruleset (blank repository)', async () => {
  const res = await validate(ctxOf([{ ...good, repository: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects an invalid target and enforcement', async () => {
  const res = await validate(ctxOf([{ ...good, target: 'commit', enforcement: 'on' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TARGET'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ENFORCEMENT'))
})

test('validate rejects malformed rules JSON', async () => {
  const res = await validate(ctxOf([{ ...good, rules: '[not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULES_JSON'))
})

test('validate rejects a non-array rules value', async () => {
  const res = await validate(ctxOf([{ ...good, rules: '{"type":"x"}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULES_JSON'))
})

test('validate warns on an empty rule set', async () => {
  const res = await validate(ctxOf([{ ...good, rules: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_RULES'))
})

test('validate warns on a duplicate ruleset in one scope', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_RULESET'))
})

// --- _shared ----------------------------------------------------------------

test('parseJsonArray: blank → [], invalid → error, object → error', () => {
  assert.deepEqual(parseJsonArray('').value, [])
  assert.ok(parseJsonArray('[bad').error)
  assert.ok(parseJsonArray('{"a":1}').error)
  assert.deepEqual(parseJsonArray('[1,2]').value, [1, 2])
})

test('parseJsonObject: blank → null, array → error, object → value', () => {
  assert.equal(parseJsonObject('').value, null)
  assert.ok(parseJsonObject('[1]').error)
  assert.deepEqual(parseJsonObject('{"a":1}').value, { a: 1 })
})

test('buildRulesetBody assembles name/target/enforcement/rules and omits empties', () => {
  const { body, errors } = buildRulesetBody(desiredFromItem({ ...good, conditions: '', bypass_actors: '' }))
  assert.equal(errors.length, 0)
  assert.equal(body.name, 'Protect main')
  assert.equal(body.target, 'branch')
  assert.equal(body.enforcement, 'active')
  assert.deepEqual(body.rules, [{ type: 'pull_request' }])
  assert.equal('conditions' in body, false)
  assert.equal('bypass_actors' in body, false)
})

test('buildRulesetBody surfaces JSON errors', () => {
  const { errors } = buildRulesetBody(desiredFromItem({ ...good, rules: '[bad', conditions: '[1]' }))
  assert.ok(errors.some((e) => e.startsWith('rules:')))
  assert.ok(errors.some((e) => e.startsWith('conditions:')))
})

test('desiredFromItem accepts pre-serialised object/array fields', () => {
  const d = desiredFromItem({ ...good, rules: [{ type: 'required_signatures' }] })
  assert.equal(d.rulesRaw, '[{"type":"required_signatures"}]')
})

test('restoreBody reconstructs a PUT body from a prior ruleset', () => {
  const body = restoreBody({
    id: 9,
    name: 'Protect main',
    target: 'branch',
    enforcement: 'evaluate',
    rules: [{ type: 'deletion' }],
    conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
    bypass_actors: [],
  })
  assert.equal(body.name, 'Protect main')
  assert.equal(body.enforcement, 'evaluate')
  assert.deepEqual(body.rules, [{ type: 'deletion' }])
  assert.ok('conditions' in body)
  assert.equal('bypass_actors' in body, false) // empty array omitted
})

test('stableStringify is order-independent for object keys', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }))
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]))
})
