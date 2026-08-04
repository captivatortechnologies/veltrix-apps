import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildProfileRep, canonicalJson, extractClientProfileSpecs, parseExecutorsField } from '../_shared'
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
  name: 'fapi-baseline-custom',
  description: 'Custom baseline profile',
  executors: JSON.stringify([{ executor: 'secure-session' }, { executor: 'pkce-enforcer' }]),
}

// --- validate ------------------------------------------------------------------

test('validate rejects a missing profile name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROFILE_NAME'))
})

test('validate rejects a profile name with whitespace', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'fapi baseline' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROFILE_NAME'))
})

test('validate ERRORS (not warns) on a duplicate profile name — whole-list PUT correctness', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'Copy' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_PROFILE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good profile', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a blank executors field (no-op profile)', async () => {
  const res = await validate(ctxOf([{ ...good, executors: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects executors that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, executors: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXECUTORS'))
})

test('validate rejects an executors value that is not a JSON array', async () => {
  const res = await validate(ctxOf([{ ...good, executors: '{"executor":"secure-session"}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXECUTORS'))
})

test('validate rejects an executor entry missing the "executor" field', async () => {
  const res = await validate(ctxOf([{ ...good, executors: JSON.stringify([{ configuration: {} }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXECUTORS'))
})

test('validate rejects an executor with a non-object configuration', async () => {
  const res = await validate(ctxOf([{ ...good, executors: JSON.stringify([{ executor: 'secure-session', configuration: 'nope' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXECUTORS'))
})

// --- _shared helpers -------------------------------------------------------------

test('parseExecutorsField treats a blank value as an empty (valid) executor list', () => {
  const result = parseExecutorsField('')
  assert.deepEqual(result, { executors: [], error: null })
})

test('parseExecutorsField parses a well-formed executor array, config included only when present', () => {
  const raw = JSON.stringify([{ executor: 'secure-session' }, { executor: 'intent-client-bind-checker', configuration: { 'auto-configure': 'true' } }])
  const result = parseExecutorsField(raw)
  assert.equal(result.error, null)
  assert.deepEqual(result.executors, [
    { executor: 'secure-session' },
    { executor: 'intent-client-bind-checker', configuration: { 'auto-configure': 'true' } },
  ])
})

test('parseExecutorsField rejects invalid JSON', () => {
  const result = parseExecutorsField('{ not json')
  assert.equal(result.executors, null)
  assert.ok(result.error)
})

test('parseExecutorsField rejects a non-array JSON value', () => {
  const result = parseExecutorsField('{"executor":"secure-session"}')
  assert.equal(result.executors, null)
  assert.ok(result.error)
})

test('parseExecutorsField rejects an array entry that is not an object', () => {
  const result = parseExecutorsField(JSON.stringify(['secure-session']))
  assert.equal(result.executors, null)
  assert.ok(result.error)
})

test('buildProfileRep includes description only when declared', () => {
  const withDescription = buildProfileRep('p1', 'a description', [])
  const withoutDescription = buildProfileRep('p1', undefined, [])
  assert.equal(withDescription.description, 'a description')
  assert.equal('description' in withoutDescription, false)
  assert.deepEqual(withoutDescription.executors, [])
})

test('extractClientProfileSpecs reads and trims every field', () => {
  const specs = extractClientProfileSpecs(
    ctxOf([{ name: '  fapi-baseline  ', description: '  note  ', executors: '[]' }]).canvas,
  )
  assert.equal(specs[0].name, 'fapi-baseline')
  assert.equal(specs[0].description, 'note')
})

test('canonicalJson is ORDER-SENSITIVE for arrays but ignores object-key order', () => {
  const a = canonicalJson([{ executor: 'a' }, { executor: 'b' }])
  const b = canonicalJson([{ executor: 'b' }, { executor: 'a' }])
  assert.notEqual(a, b)

  const c = canonicalJson([{ executor: 'a', configuration: { x: 1 } }])
  const d = canonicalJson([{ configuration: { x: 1 }, executor: 'a' }])
  assert.equal(c, d)
})
