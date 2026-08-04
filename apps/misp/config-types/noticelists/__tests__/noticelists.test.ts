import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { findNoticelist, noticelistsFromList, normalizeEnabled } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the MISP REST API via node:https inside mispApi, which
 * is impractical to mock here. Tests focus on validate.ts, which is pure and
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'GDPR', state: 'enabled', comment: 'PII handling notices' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid state', async () => {
  const res = await validate(ctxOf([{ ...good, state: 'maybe' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STATE'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good noticelist for each state', async () => {
  for (const state of ['enabled', 'disabled']) {
    const res = await validate(ctxOf([{ ...good, state }]))
    assert.equal(res.valid, true, `expected state=${state} to be valid`)
  }
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('findNoticelist matches case-insensitively', () => {
  const noticelists = noticelistsFromList([{ Noticelist: { id: 1, name: 'GDPR' } }])
  assert.ok(findNoticelist(noticelists, 'gdpr'))
  assert.equal(findNoticelist(noticelists, 'ccpa'), null)
})

test('normalizeEnabled handles enabled/disabled strings and booleans', () => {
  assert.equal(normalizeEnabled('enabled'), true)
  assert.equal(normalizeEnabled('disabled'), false)
  assert.equal(normalizeEnabled(true), true)
  assert.equal(normalizeEnabled(1), true)
})
