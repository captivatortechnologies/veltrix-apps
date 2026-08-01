import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { webhooksFromList, findWebhook, isValidWebhookUrl, scopeOf } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the SonarQube Web API via node:http(s), which is
 * impractical to mock here. Tests focus on validate.ts and _shared (pure, network-free).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Veltrix Pipeline', url: 'https://ci.example.com/sonar-hook', project: '', secret: '' }

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed webhook', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing url', async () => {
  const res = await validate(ctxOf([{ ...good, url: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_URL'))
})

test('validate rejects a non-http(s) url', async () => {
  const res = await validate(ctxOf([{ ...good, url: 'ftp://nope.example.com' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_URL'))
})

test('validate warns on a duplicate name in the same scope', async () => {
  const res = await validate(ctxOf([good, { ...good, url: 'https://other.example.com/h' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate allows the same name in different scopes', async () => {
  const res = await validate(ctxOf([good, { ...good, project: 'my-project' }]))
  assert.equal(res.valid, true)
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared -----------------------------------------------------------------

test('webhooksFromList unwraps the webhooks envelope', () => {
  assert.equal(webhooksFromList({ webhooks: [{ name: 'A' }, { name: 'B' }] }).length, 2)
  assert.equal(webhooksFromList({}).length, 0)
})

test('findWebhook matches by exact name', () => {
  const webhooks = [{ name: 'A', key: 'k1' }, { name: 'B', key: 'k2' }]
  assert.equal(findWebhook(webhooks, 'B')?.key, 'k2')
  assert.equal(findWebhook(webhooks, 'missing'), null)
})

test('isValidWebhookUrl accepts http(s) and rejects others', () => {
  assert.equal(isValidWebhookUrl('https://ci.example.com/hook'), true)
  assert.equal(isValidWebhookUrl('http://ci.example.com/hook'), true)
  assert.equal(isValidWebhookUrl('ftp://ci.example.com'), false)
  assert.equal(isValidWebhookUrl('not a url'), false)
})

test('scopeOf trims and defaults to empty (global)', () => {
  assert.equal(scopeOf('  my-project  '), 'my-project')
  assert.equal(scopeOf(undefined), '')
})
