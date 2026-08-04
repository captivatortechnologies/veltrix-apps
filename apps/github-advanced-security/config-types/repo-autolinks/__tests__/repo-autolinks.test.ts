import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { desiredFromItem, buildAutolinkBody, matchesLive, parseRepository, normalizeBool } from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.key_prefix ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { repository: 'octo-org/octo-repo', key_prefix: 'TICKET-', url_template: 'https://ticket.example.com/browse/TICKET-<num>', is_alphanumeric: true }

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects missing repository / key prefix / url template', async () => {
  const res = await validate(ctxOf([{ repository: '', key_prefix: '', url_template: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_REPOSITORY'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_KEY_PREFIX'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_URL_TEMPLATE'))
})

test('validate rejects a URL template missing <num>', async () => {
  const res = await validate(ctxOf([{ ...good, url_template: 'https://ticket.example.com/browse/TICKET' }]))
  assert.ok(res.errors.some((e) => e.code === 'MISSING_NUM_PLACEHOLDER'))
})

test('validate accepts a good autolink', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate (repository, key_prefix)', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_AUTOLINK'))
})

// --- _shared ----------------------------------------------------------------

test('parseRepository / normalizeBool behave as expected', () => {
  assert.deepEqual(parseRepository('a/b'), { owner: 'a', repo: 'b' })
  assert.equal(parseRepository('bad'), null)
  assert.equal(normalizeBool(undefined, true), true)
})

test('desiredFromItem reads identity fields', () => {
  const d = desiredFromItem(good)
  assert.equal(d.keyPrefix, 'TICKET-')
  assert.equal(d.isAlphanumeric, true)
})

test('buildAutolinkBody produces the exact POST body', () => {
  const body = buildAutolinkBody(desiredFromItem(good))
  assert.deepEqual(body, { key_prefix: 'TICKET-', url_template: good.url_template, is_alphanumeric: true })
})

test('matchesLive compares all three fields', () => {
  const desired = desiredFromItem(good)
  assert.equal(matchesLive(desired, { key_prefix: 'TICKET-', url_template: good.url_template, is_alphanumeric: true }), true)
  assert.equal(matchesLive(desired, { key_prefix: 'TICKET-', url_template: 'https://other', is_alphanumeric: true }), false)
  assert.equal(matchesLive(desired, { key_prefix: 'TICKET-', url_template: good.url_template, is_alphanumeric: false }), false)
})
