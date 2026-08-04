import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildPolicyRep, canonicalJson, extractClientPolicySpecs, liveEnabled, parseConditionsField } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers (deploy/rollback/drift) apply over the Keycloak Admin REST
 * API — a single whole-list GET/PUT — which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'fapi-baseline-policy',
  description: 'Enforce the custom baseline profile on confidential clients',
  enabled: true,
  conditions: JSON.stringify([{ condition: 'client-access-type', configuration: { type: ['confidential'] } }]),
  profiles: ['fapi-baseline-custom'],
}

// --- validate ------------------------------------------------------------------

test('validate rejects a missing policy name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_POLICY_NAME'))
})

test('validate rejects a policy name with whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'fapi baseline' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_POLICY_NAME'))
})

test('validate ERRORS (not warns) on a duplicate policy name — whole-list PUT correctness', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'Copy' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_POLICY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate WARNS (does not error) on an empty profiles list', async () => {
  const res = await validate(ctxOf([{ ...good, profiles: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_PROFILES'))
})

test('validate accepts a blank conditions field (never-matching policy)', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects conditions that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONDITIONS'))
})

test('validate rejects a conditions value that is not a JSON array', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: '{"condition":"any-client"}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONDITIONS'))
})

test('validate rejects a condition entry missing the "condition" field', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: JSON.stringify([{ configuration: {} }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONDITIONS'))
})

test('validate rejects a condition with a non-object configuration', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: JSON.stringify([{ condition: 'any-client', configuration: 'nope' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONDITIONS'))
})

// --- _shared helpers -------------------------------------------------------------

test('parseConditionsField treats a blank value as an empty (valid) condition list', () => {
  const result = parseConditionsField('')
  assert.deepEqual(result, { conditions: [], error: null })
})

test('parseConditionsField parses a well-formed condition array, config included only when present', () => {
  const raw = JSON.stringify([{ condition: 'any-client' }, { condition: 'client-access-type', configuration: { type: ['confidential'] } }])
  const result = parseConditionsField(raw)
  assert.equal(result.error, null)
  assert.deepEqual(result.conditions, [
    { condition: 'any-client' },
    { condition: 'client-access-type', configuration: { type: ['confidential'] } },
  ])
})

test('parseConditionsField rejects invalid JSON', () => {
  const result = parseConditionsField('{ not json')
  assert.equal(result.conditions, null)
  assert.ok(result.error)
})

test('parseConditionsField rejects a non-array JSON value', () => {
  const result = parseConditionsField('{"condition":"any-client"}')
  assert.equal(result.conditions, null)
  assert.ok(result.error)
})

test('parseConditionsField rejects an array entry that is not an object', () => {
  const result = parseConditionsField(JSON.stringify(['any-client']))
  assert.equal(result.conditions, null)
  assert.ok(result.error)
})

test('buildPolicyRep includes description only when declared', () => {
  const withDescription = buildPolicyRep('p1', 'a description', true, [], [])
  const withoutDescription = buildPolicyRep('p1', undefined, true, [], [])
  assert.equal(withDescription.description, 'a description')
  assert.equal('description' in withoutDescription, false)
  assert.equal(withoutDescription.enabled, true)
  assert.deepEqual(withoutDescription.conditions, [])
  assert.deepEqual(withoutDescription.profiles, [])
})

test('liveEnabled treats anything other than literal true as disabled, matching Keycloak server semantics', () => {
  assert.equal(liveEnabled({ enabled: true }), true)
  assert.equal(liveEnabled({ enabled: false }), false)
  assert.equal(liveEnabled({ enabled: undefined as unknown as boolean }), false)
})

test('extractClientPolicySpecs reads and trims every field, defaulting enabled to true', () => {
  const specs = extractClientPolicySpecs(
    ctxOf([{ name: '  fapi-baseline-policy  ', description: '  note  ', conditions: '[]', profiles: ['a', 'b'] }]).canvas,
  )
  assert.equal(specs[0].name, 'fapi-baseline-policy')
  assert.equal(specs[0].description, 'note')
  assert.equal(specs[0].enabled, true)
  assert.deepEqual(specs[0].profiles, ['a', 'b'])
})

test('canonicalJson is ORDER-SENSITIVE for arrays but ignores object-key order', () => {
  const a = canonicalJson([{ condition: 'a' }, { condition: 'b' }])
  const b = canonicalJson([{ condition: 'b' }, { condition: 'a' }])
  assert.notEqual(a, b)

  const c = canonicalJson([{ condition: 'a', configuration: { x: 1 } }])
  const d = canonicalJson([{ configuration: { x: 1 }, condition: 'a' }])
  assert.equal(c, d)
})
