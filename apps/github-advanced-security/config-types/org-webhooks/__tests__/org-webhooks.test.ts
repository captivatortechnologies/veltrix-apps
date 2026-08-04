import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { desiredFromItem, buildWebhookBody, findByUrl, restoreBody, toStringArray } from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.url ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { org: 'octo-org', url: 'https://example.com/hook', content_type: 'json', secret: 's3cr3t', insecure_ssl: '0', events: ['push', 'pull_request'], active: true }

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects missing org / url and a bad url', async () => {
  const res = await validate(ctxOf([{ ...good, org: '', url: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ORG'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_URL'))
  const res2 = await validate(ctxOf([{ ...good, url: 'ftp://example.com' }]))
  assert.ok(res2.errors.some((e) => e.code === 'INVALID_URL'))
})

test('validate accepts a good webhook', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate (org, url)', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_WEBHOOK'))
})

test('validate warns when SSL verification is disabled', async () => {
  const res = await validate(ctxOf([{ ...good, insecure_ssl: '1' }]))
  assert.ok(res.warnings.some((w) => w.code === 'SSL_VERIFICATION_DISABLED'))
})

// --- _shared ----------------------------------------------------------------

test('toStringArray parses tolerant input', () => {
  assert.deepEqual(toStringArray('push, pull_request'), ['push', 'pull_request'])
})

test('desiredFromItem defaults events to ["push"] when empty', () => {
  const d = desiredFromItem({ ...good, events: [] })
  assert.deepEqual(d.events, ['push'])
})

test('buildWebhookBody includes secret only when non-blank', () => {
  const withSecret = buildWebhookBody(desiredFromItem(good))
  assert.equal((withSecret.config as Record<string, unknown>).secret, 's3cr3t')
  const withoutSecret = buildWebhookBody(desiredFromItem({ ...good, secret: '' }))
  assert.equal('secret' in (withoutSecret.config as Record<string, unknown>), false)
})

test('findByUrl matches case-insensitively and trims', () => {
  const webhooks = [{ id: 1, config: { url: 'HTTPS://Example.com/hook ' } }]
  assert.equal(findByUrl(webhooks, ' https://example.com/hook')?.id, 1)
  assert.equal(findByUrl(webhooks, 'https://other.com'), undefined)
})

test('restoreBody never includes a secret', () => {
  const body = restoreBody({ config: { url: 'https://x', content_type: 'json', insecure_ssl: '0' }, events: ['push'], active: true })
  assert.equal('secret' in (body.config as Record<string, unknown>), false)
  assert.deepEqual(body.events, ['push'])
})
