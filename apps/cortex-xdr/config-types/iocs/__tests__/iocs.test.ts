import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildIocFields, findIoc, iocsFromReply, parseExpiration } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cortex XDR REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (identity matching + body building) — both network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.indicator ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  indicator: 'e99a18c428cb38d5f260853678922e03',
  type: 'HASH',
  severity: 'HIGH',
  reputation: 'BAD',
  reliability: 'B',
  comment: 'known malware sample',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed indicator', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing indicator value', async () => {
  const res = await validate(ctxOf([{ ...good, indicator: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INDICATOR'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'URL' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects an unknown severity', async () => {
  const res = await validate(ctxOf([{ ...good, severity: 'SEVERE' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEVERITY'))
})

test('validate rejects an unknown reputation', async () => {
  const res = await validate(ctxOf([{ ...good, reputation: 'EVIL' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_REPUTATION'))
})

test('validate rejects an unknown reliability grade', async () => {
  const res = await validate(ctxOf([{ ...good, reliability: 'Z' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RELIABILITY'))
})

test('validate rejects a non-numeric expiration', async () => {
  const res = await validate(ctxOf([{ ...good, expiration_date: 'tomorrow' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXPIRATION'))
})

test('validate accepts a numeric epoch expiration', async () => {
  const res = await validate(ctxOf([{ ...good, expiration_date: '1785000000000' }]))
  assert.equal(res.valid, true)
})

test('validate allows blank optional reputation / reliability', async () => {
  const res = await validate(ctxOf([{ ...good, reputation: '', reliability: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate indicator value', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_INDICATOR'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('buildIocFields omits empty optional fields', () => {
  const ioc = buildIocFields({ indicator: '1.2.3.4', type: 'IP', severity: 'LOW' })
  assert.equal(ioc.indicator, '1.2.3.4')
  assert.equal(ioc.type, 'IP')
  assert.equal(ioc.severity, 'LOW')
  assert.equal('reputation' in ioc, false)
  assert.equal('comment' in ioc, false)
  assert.equal('expiration_date' in ioc, false)
})

test('buildIocFields includes a valid expiration', () => {
  const ioc = buildIocFields({ ...good, expiration_date: '1785000000000' })
  assert.equal(ioc.expiration_date, 1785000000000)
})

test('parseExpiration rejects non-positive / non-integer values', () => {
  assert.equal(parseExpiration(''), null)
  assert.equal(parseExpiration('0'), null)
  assert.equal(parseExpiration('-5'), null)
  assert.equal(parseExpiration('abc'), null)
  assert.equal(parseExpiration('123'), 123)
})

test('findIoc matches case-insensitively on the indicator value', () => {
  const live = [{ indicator: 'E99A18C428CB38D5F260853678922E03', severity: 'LOW' }]
  const match = findIoc(live, 'e99a18c428cb38d5f260853678922e03')
  assert.ok(match)
  assert.equal(match?.severity, 'LOW')
})

test('iocsFromReply unwraps both the array and { indicators } shapes', () => {
  assert.equal(iocsFromReply([{ indicator: 'a' }]).length, 1)
  assert.equal(iocsFromReply({ indicators: [{ indicator: 'b' }, { indicator: 'c' }] }).length, 2)
  assert.equal(iocsFromReply(null).length, 0)
})
