import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildFeedInput, buildRestoreInput, feedsFromList, findFeed, parseFeedAttributes, toStringList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus
 * on validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Daily Indicator Export',
  description: 'Rolling indicator CSV export',
  separator: ';',
  feed_date_attribute: 'created_at',
  rolling_time: 60,
  include_header: true,
  feed_types: ['Indicator'],
  feed_public: false,
  filters: '{"mode":"and","filters":[],"filterGroups":[]}',
  feed_attributes: JSON.stringify([{ attribute: 'value', mappings: [{ type: 'simple', attribute: 'pattern' }] }]),
}

test('validate rejects a missing name / separator / date attribute', async () => {
  const res = await validate(ctxOf([{ ...good, name: '', separator: '', feed_date_attribute: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SEPARATOR'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DATE_ATTRIBUTE'))
})

test('validate rejects a non-positive rolling_time', async () => {
  const res = await validate(ctxOf([{ ...good, rolling_time: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLLING_TIME'))
})

test('validate rejects no entity types', async () => {
  const res = await validate(ctxOf([{ ...good, feed_types: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FEED_TYPES'))
})

test('validate rejects malformed filters JSON', async () => {
  const res = await validate(ctxOf([{ ...good, filters: '{bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTERS_JSON'))
})

test('validate rejects missing / malformed / malshaped feed_attributes', async () => {
  const missing = await validate(ctxOf([{ ...good, feed_attributes: '' }]))
  assert.ok(missing.errors.some((e) => e.code === 'EMPTY_FEED_ATTRIBUTES'))

  const malformed = await validate(ctxOf([{ ...good, feed_attributes: '{bad' }]))
  assert.ok(malformed.errors.some((e) => e.code === 'INVALID_FEED_ATTRIBUTES_JSON'))

  const notArray = await validate(ctxOf([{ ...good, feed_attributes: '{}' }]))
  assert.ok(notArray.errors.some((e) => e.code === 'INVALID_FEED_ATTRIBUTES_SHAPE'))

  const badEntry = await validate(ctxOf([{ ...good, feed_attributes: JSON.stringify([{ attribute: 'x' }]) }]))
  assert.ok(badEntry.errors.some((e) => e.code === 'INVALID_FEED_ATTRIBUTES_SHAPE'))
})

test('validate warns on a duplicate feed name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'dup' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good feed', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('parseFeedAttributes parses the JSON array and rejects a non-array', () => {
  const parsed = parseFeedAttributes(good.feed_attributes)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].attribute, 'value')
  assert.throws(() => parseFeedAttributes('{}'))
})

test('buildFeedInput builds the full input and defaults feed_public_user_id/authorized_members from prior (never authors them)', () => {
  const created = buildFeedInput(good, null)
  assert.equal(created.name, 'Daily Indicator Export')
  assert.equal(created.feed_public_user_id, undefined)
  assert.equal(created.authorized_members, undefined)

  const prior = { feed_public_user_id: 'user--1', authorized_members: [{ id: 'm1', access_right: 'view' }] }
  const updated = buildFeedInput(good, prior)
  assert.equal(updated.feed_public_user_id, 'user--1')
  assert.deepEqual(updated.authorized_members, [{ id: 'm1', access_right: 'view', groups_restriction_ids: [] }])
})

test('buildRestoreInput reconstructs a full FeedAddInput from a prior live node', () => {
  const prior = {
    name: 'Daily Indicator Export',
    separator: ';',
    feed_date_attribute: 'created_at',
    rolling_time: 60,
    include_header: true,
    feed_types: ['Indicator'],
    feed_attributes: [{ attribute: 'value', mappings: [{ type: 'simple', attribute: 'pattern' }] }],
    feed_public: false,
  }
  const restored = buildRestoreInput(prior)
  assert.equal(restored.name, 'Daily Indicator Export')
  assert.equal(restored.rolling_time, 60)
  assert.deepEqual(restored.feed_types, ['Indicator'])
  assert.deepEqual(restored.feed_attributes, prior.feed_attributes)
})

test('toStringList normalizes array and comma-separated values', () => {
  assert.deepEqual(toStringList(['Indicator', 'Indicator', 'Report']), ['Indicator', 'Report'])
  assert.deepEqual(toStringList('Indicator, Report'), ['Indicator', 'Report'])
})

test('feedsFromList unwraps the edges/node connection', () => {
  const list = feedsFromList({
    feeds: { edges: [{ node: { id: '1', name: 'Daily Indicator Export' } }, { node: { id: '2', name: 'Other' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findFeed(list, 'daily indicator export')?.id, '1')
})
