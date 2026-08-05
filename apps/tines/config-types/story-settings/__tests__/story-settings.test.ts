import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractStorySettingsSpecs,
  keepEventsForSeconds,
  tagsToAdd,
  tagsToRemove,
  buildStorySettingsBody,
  findStoryByName,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.story_name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { story_name: 'Phishing Triage', disabled: false }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing story_name', async () => {
  const res = await validate(ctxOf([{ story_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_STORY_NAME'))
})

test('validate rejects an out-of-range retention', async () => {
  const res = await validate(ctxOf([{ ...good, keep_events_for_days: 400 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RETENTION'))
})

test('validate warns on a duplicate (team, story_name)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('keepEventsForSeconds converts days and clamps to Tines bounds', () => {
  assert.equal(keepEventsForSeconds(1), 86_400)
  assert.equal(keepEventsForSeconds(0), 3600) // clamped to the minimum
  assert.equal(keepEventsForSeconds(1000), 31_536_000) // clamped to the maximum
})

test('tagsToAdd / tagsToRemove compute the diff case-insensitively', () => {
  assert.deepEqual(tagsToAdd(['Urgent', 'phishing'], ['phishing']), ['Urgent'])
  assert.deepEqual(tagsToRemove(['phishing'], ['phishing', 'stale']), ['stale'])
})

test('buildStorySettingsBody never includes team_id (search-only, never moves the story)', () => {
  const spec = extractStorySettingsSpecs(ctxOf([good]).canvas)[0]
  const body = buildStorySettingsBody(spec, ['urgent'], [], null)
  assert.equal((body as Record<string, unknown>).team_id, undefined)
  assert.deepEqual(body.add_tag_names, ['urgent'])
  assert.equal(body.disabled, false)
})

test('findStoryByName matches by exact case-insensitive name', () => {
  const live = [{ id: 1, name: 'Phishing Triage' }, { id: 2, name: 'Onboarding' }]
  assert.equal(findStoryByName(live, 'phishing triage')?.id, 1)
  assert.equal(findStoryByName(live, 'missing'), null)
})
