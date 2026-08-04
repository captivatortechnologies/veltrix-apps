import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  bundleFromSpec,
  detectionPolicySpecFromFields,
  exceptionsEqual,
  extractDetectionPolicySpecs,
  isDetectionPolicyProduct,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Semgrep REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers — all network-free (validate's live dry-run pre-flight is
 * itself skipped whenever ctx.credential / ctx.component are absent, which is
 * the case for every fixture below).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.product ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { product: 'code', rulesets: ['p/owasp-top-10'], rules: [], disabled: [], exceptionsJson: '[]' }

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed code detection policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects an unknown product', async () => {
  const res = await validate(ctxOf([{ ...good, product: 'sca' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PRODUCT'))
})

test('validate rejects a duplicate product', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_PRODUCT'))
})

test('validate rejects rulesets on a secrets bundle', async () => {
  const res = await validate(ctxOf([{ ...good, product: 'secrets' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SECRETS_RULESETS_NOT_ALLOWED'))
})

test('validate accepts an empty-ruleset secrets bundle', async () => {
  const res = await validate(ctxOf([{ ...good, product: 'secrets', rulesets: [] }]))
  assert.equal(res.valid, true)
})

test('validate rejects malformed exceptions JSON', async () => {
  const res = await validate(ctxOf([{ ...good, exceptionsJson: 'not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXCEPTIONS_JSON'))
})

test('validate rejects an exception with neither project nor project_tag_name', async () => {
  const exc = JSON.stringify([{ exception_type: 'exclude', rule: 'r', rule_type: 'rule' }])
  const res = await validate(ctxOf([{ ...good, exceptionsJson: exc }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EXCEPTION_SCOPE_AMBIGUOUS'))
})

test('validate rejects an exception with BOTH project and project_tag_name', async () => {
  const exc = JSON.stringify([{ exception_type: 'exclude', project: 'a/b', project_tag_name: 'tag', rule: 'r', rule_type: 'rule' }])
  const res = await validate(ctxOf([{ ...good, exceptionsJson: exc }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EXCEPTION_SCOPE_AMBIGUOUS'))
})

test('validate accepts a well-formed exception', async () => {
  const exc = JSON.stringify([{ exception_type: 'exclude', project: 'a/b', rule: 'r', rule_type: 'rule' }])
  const res = await validate(ctxOf([{ ...good, exceptionsJson: exc }]))
  assert.equal(res.valid, true)
})

test('validate rejects an invalid exception_type / rule_type', async () => {
  const exc = JSON.stringify([{ exception_type: 'maybe', project: 'a/b', rule: 'r', rule_type: 'ruleset' }])
  const res = await validate(ctxOf([{ ...good, exceptionsJson: exc }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXCEPTION_TYPE'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXCEPTION_RULE_TYPE'))
})

// --- _shared helpers ------------------------------------------------------------

test('detectionPolicySpecFromFields parses exceptions JSON', () => {
  const spec = detectionPolicySpecFromFields({
    product: 'code',
    exceptionsJson: '[{"exception_type":"include","rule":"r","rule_type":"rule","project":"a/b"}]',
  })
  assert.equal(spec.exceptions?.length, 1)
  assert.equal(spec.exceptions?.[0].rule, 'r')
})

test('detectionPolicySpecFromFields reports null exceptions on invalid JSON', () => {
  const spec = detectionPolicySpecFromFields({ product: 'code', exceptionsJson: '{not valid' })
  assert.equal(spec.exceptions, null)
})

test('detectionPolicySpecFromFields treats a blank exceptionsJson as an empty list', () => {
  const spec = detectionPolicySpecFromFields({ product: 'code' })
  assert.deepEqual(spec.exceptions, [])
})

test('bundleFromSpec maps the spec onto the API bundle shape', () => {
  const spec = detectionPolicySpecFromFields(good)
  const bundle = bundleFromSpec(spec)
  assert.deepEqual(bundle, { product: 'code', rulesets: ['p/owasp-top-10'], rules: [], disabled: [], exceptions: [] })
})

test('extractDetectionPolicySpecs reads every item', () => {
  const specs = extractDetectionPolicySpecs(ctxOf([good, { ...good, product: 'secrets', rulesets: [] }]).canvas)
  assert.equal(specs.length, 2)
  assert.equal(specs[1].product, 'secrets')
})

test('isDetectionPolicyProduct narrows valid products only', () => {
  assert.equal(isDetectionPolicyProduct('code'), true)
  assert.equal(isDetectionPolicyProduct('secrets'), true)
  assert.equal(isDetectionPolicyProduct('sca'), false)
  assert.equal(isDetectionPolicyProduct(''), false)
})

test('exceptionsEqual is order-insensitive and length/content aware', () => {
  const a = [
    { exception_type: 'include' as const, rule: 'r1', rule_type: 'rule' as const, project: 'a/b' },
    { exception_type: 'exclude' as const, rule: 'r2', rule_type: 'pack' as const, project_tag_name: 'tag' },
  ]
  const b = [a[1], a[0]]
  assert.equal(exceptionsEqual(a, b), true)
  assert.equal(exceptionsEqual(a, [a[0]]), false)
  assert.equal(exceptionsEqual([], []), true)
})
