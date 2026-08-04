import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { definitionsFromListResponse } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the SonarQube Web API via node:http(s), which is
 * impractical to mock here. Tests focus on validate.ts and _shared (pure, network-free).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.key ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodGithub = {
  key: 'gh-main',
  almType: 'github',
  url: 'https://api.github.com',
  appId: '12345',
  clientId: 'Iv1.12345c6789az',
  clientSecret: 'super-secret',
  privateKey: 'test-fixture-private-key-not-a-real-credential',
  webhookSecret: '',
  personalAccessToken: '',
  workspace: '',
}

// --- validate ----------------------------------------------------------------

test('validate accepts a fully-populated github item with no warnings', async () => {
  const res = await validate(ctxOf([goodGithub]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
  assert.equal(res.warnings.length, 0)
})

test('validate warns (not errors) when a github item is missing clientSecret', async () => {
  const res = await validate(ctxOf([{ ...goodGithub, clientSecret: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_ON_CREATE' && w.field.endsWith('.clientSecret')))
})

test('validate warns on every blank required-on-create field for a mostly-empty github item', async () => {
  const res = await validate(ctxOf([{ key: 'gh-empty', almType: 'github' }]))
  assert.equal(res.valid, true)
  const fields = res.warnings.filter((w) => w.code === 'MISSING_ON_CREATE').map((w) => w.field)
  assert.ok(fields.some((f) => f.endsWith('.url')))
  assert.ok(fields.some((f) => f.endsWith('.appId')))
  assert.ok(fields.some((f) => f.endsWith('.clientId')))
  assert.ok(fields.some((f) => f.endsWith('.clientSecret')))
  assert.ok(fields.some((f) => f.endsWith('.privateKey')))
})

test('validate errors on a missing key', async () => {
  const res = await validate(ctxOf([{ ...goodGithub, key: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_KEY'))
})

test('validate errors on a missing almType', async () => {
  const res = await validate(ctxOf([{ ...goodGithub, almType: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ALM_TYPE'))
})

test('validate errors on an unrecognized almType value', async () => {
  const res = await validate(ctxOf([{ ...goodGithub, almType: 'perforce' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ALM_TYPE'))
})

test('validate requires clientId/clientSecret/workspace (not url) for bitbucketcloud, and does not warn on a blank url', async () => {
  const incomplete = { key: 'bbc-1', almType: 'bitbucketcloud', clientId: '', clientSecret: '', workspace: '', url: '' }
  const res = await validate(ctxOf([incomplete]))
  assert.equal(res.valid, true)
  const codes = res.warnings.filter((w) => w.code === 'MISSING_ON_CREATE').map((w) => w.field)
  assert.ok(codes.some((f) => f.endsWith('.clientId')))
  assert.ok(codes.some((f) => f.endsWith('.clientSecret')))
  assert.ok(codes.some((f) => f.endsWith('.workspace')))
  assert.ok(!codes.some((f) => f.endsWith('.url')))

  const complete = { key: 'bbc-2', almType: 'bitbucketcloud', clientId: 'abc', clientSecret: 'xyz', workspace: 'my-workspace', url: '' }
  const res2 = await validate(ctxOf([complete]))
  assert.equal(res2.valid, true)
  assert.equal(res2.warnings.filter((w) => w.code === 'MISSING_ON_CREATE').length, 0)
})

test('validate errors on a duplicate key across items', async () => {
  const res = await validate(ctxOf([goodGithub, { ...goodGithub, almType: 'gitlab', url: 'https://gitlab.example.com', personalAccessToken: 'tok' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_KEY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared: definitionsFromListResponse -------------------------------------

const VERIFIED_LIST_DEFINITIONS_RESPONSE = {
  github: [{ key: 'gh1', url: 'https://api.github.com', appId: '12345', clientId: 'Iv1.12345c6789az' }],
  azure: [],
  bitbucket: [],
  gitlab: [],
  bitbucketcloud: [],
}

test('definitionsFromListResponse parses the exact verified live shape', () => {
  const map = definitionsFromListResponse(VERIFIED_LIST_DEFINITIONS_RESPONSE)
  assert.equal(map.size, 1)

  const gh1 = map.get('gh1')
  assert.ok(gh1)
  assert.equal(gh1?.almType, 'github')
  assert.equal(gh1?.key, 'gh1')
  assert.equal(gh1?.url, 'https://api.github.com')
  assert.equal(gh1?.appId, '12345')
  assert.equal(gh1?.clientId, 'Iv1.12345c6789az')
  assert.equal(gh1?.workspace, undefined)

  // No secret field is ever present, even as undefined-on-a-typed-property — the parser
  // does not know how to read one, by design.
  const untyped = gh1 as unknown as Record<string, unknown>
  assert.equal(untyped.clientSecret, undefined)
  assert.equal(untyped.privateKey, undefined)
  assert.equal(untyped.webhookSecret, undefined)
})

test('definitionsFromListResponse parses azure/bitbucket/gitlab {key,url} and bitbucketcloud {key,clientId,workspace} shapes, minus their secrets', () => {
  const payload = {
    github: [],
    azure: [{ key: 'az1', url: 'https://dev.azure.com/org' }],
    bitbucket: [{ key: 'bb1', url: 'https://bitbucket.example.com' }],
    gitlab: [{ key: 'gl1', url: 'https://gitlab.example.com' }],
    bitbucketcloud: [{ key: 'bbc1', clientId: 'client-abc', workspace: 'my-workspace' }],
  }
  const map = definitionsFromListResponse(payload)
  assert.equal(map.size, 4)
  assert.equal(map.get('az1')?.almType, 'azure')
  assert.equal(map.get('az1')?.url, 'https://dev.azure.com/org')
  assert.equal(map.get('bb1')?.almType, 'bitbucket')
  assert.equal(map.get('gl1')?.almType, 'gitlab')
  const bbc1 = map.get('bbc1')
  assert.equal(bbc1?.almType, 'bitbucketcloud')
  assert.equal(bbc1?.clientId, 'client-abc')
  assert.equal(bbc1?.workspace, 'my-workspace')
  assert.equal(bbc1?.url, undefined)
})

test('definitionsFromListResponse is defensive against missing/non-array/non-object payloads', () => {
  assert.equal(definitionsFromListResponse(null).size, 0)
  assert.equal(definitionsFromListResponse(undefined).size, 0)
  assert.equal(definitionsFromListResponse('not an object').size, 0)
  assert.equal(definitionsFromListResponse({}).size, 0)
  assert.equal(definitionsFromListResponse({ github: 'not-an-array' }).size, 0)
  assert.equal(definitionsFromListResponse({ github: [null, 42, { noKey: true }] }).size, 0)
})
