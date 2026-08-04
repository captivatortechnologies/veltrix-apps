import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildFeedInput, buildFeedPatch, feedsFromList, findFeed } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus on
 * validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'MITRE ATT&CK',
  uri: 'https://cti-taxii.mitre.org/taxii/',
  collection: '95ecc380-afe9-11e4-9b6c-751b66dd541e',
  version: 'v21',
  authentication_type: 'none',
  user_id: '88ec0c6a-13ce-5e39-b486-354fe4a54a4b',
}

test('validate accepts a good feed', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name / uri / collection / user_id', async () => {
  const res = await validate(ctxOf([{ ...good, name: '', uri: '', collection: '', user_id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_URI'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_COLLECTION'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_USER_ID'))
})

test('validate rejects a non-http URI', async () => {
  const res = await validate(ctxOf([{ ...good, uri: 'ftp://example.com' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_URI'))
})

test('validate accepts every real TaxiiVersion enum value (v1, v2, v21) and rejects an unknown one', async () => {
  for (const version of ['v1', 'v2', 'v21']) {
    const res = await validate(ctxOf([{ ...good, version }]))
    assert.equal(res.valid, true, `expected version "${version}" to be valid`)
  }
  const ver = await validate(ctxOf([{ ...good, version: 'v20' }]))
  assert.ok(ver.errors.some((e) => e.code === 'INVALID_VERSION'), '"v20" is not a real TaxiiVersion value and must be rejected')
})

test('validate rejects an unknown auth type', async () => {
  const auth = await validate(ctxOf([{ ...good, authentication_type: 'oauth' }]))
  assert.ok(auth.errors.some((e) => e.code === 'INVALID_AUTH_TYPE'))
})

test('validate warns when an auth type needs a value but none is given', async () => {
  const res = await validate(ctxOf([{ ...good, authentication_type: 'bearer' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_AUTH_VALUE'))
})

test('validate rejects a malformed import-from date', async () => {
  const res = await validate(ctxOf([{ ...good, added_after_start: 'last week' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DATE'))
})

test('validate warns on a duplicate feed name', async () => {
  const res = await validate(ctxOf([good, { ...good, collection: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildFeedInput carries required fields (including user_id) and omits blank optionals', () => {
  const input = buildFeedInput(good)
  assert.equal(input.name, 'MITRE ATT&CK')
  assert.equal(input.version, 'v21')
  assert.equal(input.authentication_type, 'none')
  assert.equal(input.user_id, '88ec0c6a-13ce-5e39-b486-354fe4a54a4b')
  assert.equal(input.authentication_value, undefined)
  assert.equal(input.added_after_start, undefined)

  const withSecret = buildFeedInput({ ...good, authentication_type: 'bearer', authentication_value: 'tok', added_after_start: '2024-01-01' })
  assert.equal(withSecret.authentication_value, 'tok')
  assert.equal(withSecret.added_after_start, '2024-01-01')
})

test('buildFeedPatch never patches the identity, always patches user_id, and omits an unchanged secret', () => {
  const patch = buildFeedPatch(good)
  assert.ok(patch.every((p) => p.key !== 'name'))
  assert.ok(patch.some((p) => p.key === 'uri'))
  assert.ok(patch.every((p) => p.key !== 'authentication_value'))
  const userId = patch.find((p) => p.key === 'user_id')
  assert.deepEqual(userId?.value, ['88ec0c6a-13ce-5e39-b486-354fe4a54a4b'])

  const withSecret = buildFeedPatch({ ...good, authentication_value: 'tok' })
  const secret = withSecret.find((p) => p.key === 'authentication_value')
  assert.deepEqual(secret?.value, ['tok'])
})

test('feedsFromList unwraps the edges/node connection', () => {
  const list = feedsFromList({
    ingestionTaxiis: { edges: [{ node: { id: '1', name: 'MITRE ATT&CK' } }, { node: { id: '2', name: 'AbuseCH' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findFeed(list, 'mitre att&ck')?.id, '1')
})
