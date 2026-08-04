import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { normalizeItem, groupByTeam, toBatchEntry, toTeamId, parseLabelList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the Fleet REST API via node:https inside fleetApi,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared.ts helpers (grouping, batch-entry shaping), which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Firewall baseline',
  platform: 'macos',
  displayName: '',
  profileContent: '<?xml version="1.0"?><plist></plist>',
  teamId: '',
  labelsIncludeAll: '',
  labelsIncludeAny: '',
  labelsExcludeAny: '',
}

test('validate rejects an unsafe profile name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad/../name' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unknown platform', async () => {
  const res = await validate(ctxOf([{ ...good, platform: 'linux' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PLATFORM'))
})

test('validate rejects empty profile content', async () => {
  const res = await validate(ctxOf([{ ...good, profileContent: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONTENT'))
})

test('validate requires displayName for Windows profiles', async () => {
  const res = await validate(ctxOf([{ ...good, platform: 'windows', profileContent: '<Config/>', displayName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_DISPLAY_NAME'))
})

test('validate accepts a Windows profile with a displayName', async () => {
  const res = await validate(ctxOf([{ ...good, platform: 'windows', profileContent: '<Config/>', displayName: 'BitLocker' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a non-numeric team id', async () => {
  const res = await validate(ctxOf([{ ...good, teamId: 'abc' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TEAM_ID'))
})

test('validate rejects combining Include All and Include Any label targeting', async () => {
  const res = await validate(ctxOf([{ ...good, labelsIncludeAll: 'A', labelsIncludeAny: 'B' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'CONFLICTING_LABEL_TARGETING'))
})

test('validate warns on macOS content that does not look like plist/JSON', async () => {
  const res = await validate(ctxOf([{ ...good, profileContent: 'not-a-profile' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNVERIFIED_CONTENT_SHAPE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared.ts -------------------------------------------------------------

test('toTeamId maps blank to undefined ("Unassigned") and parses numbers', () => {
  assert.equal(toTeamId(''), undefined)
  assert.equal(toTeamId(undefined), undefined)
  assert.equal(toTeamId('7'), 7)
})

test('parseLabelList trims and drops empty entries', () => {
  assert.deepEqual(parseLabelList(' Engineering ,, QA '), ['Engineering', 'QA'])
})

test('groupByTeam buckets items by teamId, keeping undefined ("Unassigned") separate', () => {
  const items = [
    normalizeItem({ ...good, name: 'a', teamId: '1' }),
    normalizeItem({ ...good, name: 'b', teamId: '' }),
    normalizeItem({ ...good, name: 'c', teamId: '1' }),
  ]
  const groups = groupByTeam(items)
  assert.equal(groups.size, 2)
  assert.equal(groups.get(1)?.length, 2)
  assert.equal(groups.get(undefined)?.length, 1)
})

test('toBatchEntry base64-encodes content and includes labels/display_name when set', () => {
  const item = normalizeItem({ ...good, displayName: 'BitLocker', labelsIncludeAny: 'Engineering, QA' })
  const entry = toBatchEntry(item, Buffer.from(item.profileContent, 'utf8').toString('base64'))
  assert.equal(entry.display_name, 'BitLocker')
  assert.deepEqual(entry.labels_include_any, ['Engineering', 'QA'])
  assert.equal(entry.labels_include_all, undefined)
  assert.equal(Buffer.from(entry.profile as string, 'base64').toString('utf8'), item.profileContent)
})
