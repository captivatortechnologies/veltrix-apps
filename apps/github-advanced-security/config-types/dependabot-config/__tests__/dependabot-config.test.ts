import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { parseRepository, normalizeBool, desiredFromItem } from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.repository ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { repository: 'octo-org/octo-repo', vulnerability_alerts: true, security_updates: true }

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing repository', async () => {
  const res = await validate(ctxOf([{ ...good, repository: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_REPOSITORY'))
})

test('validate rejects a malformed repository', async () => {
  const res = await validate(ctxOf([{ ...good, repository: 'no-slash' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_REPOSITORY'))
})

test('validate accepts a good repository', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate repository', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_REPOSITORY'))
})

test('validate warns when security updates has no alerts', async () => {
  const res = await validate(ctxOf([{ ...good, vulnerability_alerts: false, security_updates: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UPDATES_WITHOUT_ALERTS'))
})

// --- _shared ----------------------------------------------------------------

test('parseRepository splits owner/repo and rejects bad input', () => {
  assert.deepEqual(parseRepository('octo-org/octo-repo'), { owner: 'octo-org', repo: 'octo-repo' })
  assert.equal(parseRepository('no-slash'), null)
  assert.equal(parseRepository('a/b/c'), null)
  assert.equal(parseRepository(''), null)
})

test('normalizeBool coerces canvas values', () => {
  for (const truthy of [true, 'true', 'enabled', '1', 'yes', 'on']) assert.equal(normalizeBool(truthy), true)
  for (const falsy of [false, 'false', 'disabled', '0', '', undefined, null]) assert.equal(normalizeBool(falsy), false)
})

test('desiredFromItem reads identity + both flags', () => {
  const d = desiredFromItem(good)
  assert.equal(d.repository, 'octo-org/octo-repo')
  assert.equal(d.vulnerability_alerts, true)
  assert.equal(d.security_updates, true)
})
