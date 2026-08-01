import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  normalizeEntity,
  parseText,
  selectAllEntities,
  buildTagBody,
  tagNamesFromResponse,
  tagExists,
  labelsResource,
  EXPIRATION_RE,
} from '../_shared'
import { apiUrl } from '../../../lib/axoniusApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Axonius REST API via node:https
 * inside axoniusApi, which is impractical to mock here. Tests cover validate.ts and
 * the pure _shared helpers (identity, body building, JSON:API unwrapping).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Windows',
  entity: 'devices',
  filter: '(specific_data.data.os.type == "Windows")',
  expiration: '',
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing tag name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown asset module', async () => {
  const res = await validate(ctxOf([{ ...good, entity: 'vulnerabilities' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ENTITY'))
})

test('validate rejects an empty filter (would tag every asset)', async () => {
  const res = await validate(ctxOf([{ ...good, filter: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FILTER'))
})

test('validate rejects a malformed expiration date', async () => {
  const res = await validate(ctxOf([{ ...good, expiration: '31-12-2026' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXPIRATION'))
})

test('validate accepts a well-formed tag for both modules', async () => {
  for (const entity of ['devices', 'users']) {
    const res = await validate(ctxOf([{ ...good, entity }]))
    assert.equal(res.valid, true, `expected ${entity} to be valid`)
  }
})

test('validate accepts a valid expiration date', async () => {
  const res = await validate(ctxOf([{ ...good, expiration: '2026-12-31' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate tag within the same module', async () => {
  const res = await validate(ctxOf([good, { ...good, filter: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TAG'))
})

test('validate does NOT flag same tag across different modules', async () => {
  const res = await validate(ctxOf([good, { ...good, entity: 'users' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_TAG'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- helpers ----------------------------------------------------------------

test('normalizeEntity defaults to devices', () => {
  assert.equal(normalizeEntity('users'), 'users')
  assert.equal(normalizeEntity('DEVICES'), 'devices')
  assert.equal(normalizeEntity('nope'), 'devices')
})

test('parseText trims', () => {
  assert.equal(parseText('  x '), 'x')
  assert.equal(parseText(undefined), '')
})

test('EXPIRATION_RE matches ISO dates only', () => {
  assert.ok(EXPIRATION_RE.test('2026-12-31'))
  assert.ok(!EXPIRATION_RE.test('2026/12/31'))
})

test('labelsResource targets the module labels path', () => {
  assert.equal(labelsResource('devices'), 'devices/labels')
  assert.equal(labelsResource('users'), 'users/labels')
})

// --- body building ----------------------------------------------------------

test('selectAllEntities is the inverted empty selection', () => {
  assert.deepEqual(selectAllEntities(), { ids: [], include: false })
})

test('buildTagBody produces an add_tags_schema body with entities, labels and filter', () => {
  const body = buildTagBody({ label: 'Windows', filter: 'f' })
  assert.equal(body.data.type, 'add_tags_schema')
  assert.deepEqual(body.data.attributes.entities, { ids: [], include: false })
  assert.deepEqual(body.data.attributes.labels, ['Windows'])
  assert.equal(body.data.attributes.filter, 'f')
  assert.deepEqual(body.data.attributes.expirable_tags, [])
})

test('buildTagBody records an expirable tag for a valid expiration', () => {
  const body = buildTagBody({ label: 'Temp', filter: 'f', expiration: '2026-12-31' })
  assert.deepEqual(body.data.attributes.expirable_tags, [{ name: 'Temp', expiration_date: '2026-12-31' }])
})

test('buildTagBody ignores a malformed expiration', () => {
  const body = buildTagBody({ label: 'Temp', filter: 'f', expiration: 'nope' })
  assert.deepEqual(body.data.attributes.expirable_tags, [])
})

// --- response unwrapping ----------------------------------------------------

test('tagNamesFromResponse reads StrValue rows, bare strings and { value } attrs', () => {
  assert.deepEqual(
    tagNamesFromResponse({
      data: [
        { type: 'string_value_schema', attributes: { value: 'Windows' } },
        { type: 'string_value_schema', attributes: { value: 'Linux' } },
      ],
    }),
    ['Windows', 'Linux'],
  )
  assert.deepEqual(tagNamesFromResponse({ data: ['A', 'B'] }), ['A', 'B'])
})

test('tagExists matches an exact label', () => {
  assert.equal(tagExists(['Windows', 'Linux'], 'Windows'), true)
  assert.equal(tagExists(['Windows'], 'windows'), false)
  assert.equal(tagExists([], 'x'), false)
})

test('apiUrl joins base, root and the labels resource', () => {
  assert.equal(apiUrl('https://tenant.axonius.com', undefined, labelsResource('devices')), 'https://tenant.axonius.com/api/devices/labels')
})
