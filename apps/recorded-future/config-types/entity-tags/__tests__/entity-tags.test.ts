import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseTags,
  buildEntityRef,
  findCompanyList,
  listsFromResponse,
  taggedEntitiesFromResponse,
  findTaggedEntity,
  tagsOf,
  tagName,
  sameTagSet,
  normalize,
  AVAILABLE_TAGS,
  MAX_TAGS_PER_ENTITY,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Recorded Future List API via
 * fetch, which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (tag parsing, entity-ref building, list/entity matching, tag-set
 * comparison) — all network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.entityRef ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  listName: 'Third Parties',
  entityRef: 'CK2WP',
  matchBy: 'id',
  tags: ['tier1', 'critical', 'gdpr'],
  comment: 'critical supplier',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed entity tagging', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing list name', async () => {
  const res = await validate(ctxOf([{ ...good, listName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_LIST'))
})

test('validate rejects a missing entity reference', async () => {
  const res = await validate(ctxOf([{ ...good, entityRef: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ENTITY'))
})

test('validate rejects an invalid match-by mode', async () => {
  const res = await validate(ctxOf([{ ...good, matchBy: 'uuid' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MATCH_BY'))
})

test('validate accepts match-by name', async () => {
  const res = await validate(ctxOf([{ ...good, matchBy: 'name', entityRef: 'Rostelecom' }]))
  assert.equal(res.valid, true)
})

test('validate rejects more than the max tags', async () => {
  const tags = ['tier1', 'tier2', 'critical', 'high', 'gdpr', 'hipaa', 'pii', 'sox', 'financial', 'cloud']
  assert.equal(tags.length, MAX_TAGS_PER_ENTITY + 1)
  const res = await validate(ctxOf([{ ...good, tags }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'TOO_MANY_TAGS'))
})

test('validate rejects a malformed tag', async () => {
  const res = await validate(ctxOf([{ ...good, tags: ['Tier 1'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TAG_FORMAT'))
})

test('validate warns on an unknown but well-formed tag', async () => {
  const res = await validate(ctxOf([{ ...good, tags: ['made_up_tag'] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNKNOWN_TAG'))
})

test('validate warns when the tag set is empty (clears tags)', async () => {
  const res = await validate(ctxOf([{ ...good, tags: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_TAGS'))
})

test('validate warns on a duplicate (list, entity) target', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TARGET'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- parseTags ----------------------------------------------------------------

test('parseTags accepts a string array and normalises + de-duplicates', () => {
  assert.deepEqual(parseTags(['Tier1', 'tier1', ' GDPR ', 'pii']), ['tier1', 'gdpr', 'pii'])
})

test('parseTags splits a comma / newline string', () => {
  assert.deepEqual(parseTags('tier1, critical\ngdpr'), ['tier1', 'critical', 'gdpr'])
})

test('parseTags returns an empty array for blank input', () => {
  assert.deepEqual(parseTags(''), [])
  assert.deepEqual(parseTags(null), [])
})

// --- buildEntityRef -----------------------------------------------------------

test('buildEntityRef sends an RF id by default and a Company name when match-by is name', () => {
  assert.deepEqual(buildEntityRef('id', 'CK2WP'), { id: 'CK2WP' })
  assert.deepEqual(buildEntityRef('name', 'Rostelecom'), { type: 'Company', name: 'Rostelecom' })
})

// --- findCompanyList ----------------------------------------------------------

test('findCompanyList matches by name case-insensitively, preferring company type', () => {
  const lists = [
    { id: 'report:a', name: 'third parties', type: 'ip' },
    { id: 'report:b', name: 'Third Parties', type: 'company' },
  ]
  assert.equal(findCompanyList(lists, 'third parties')?.id, 'report:b')
  assert.equal(findCompanyList(lists, 'nope'), null)
})

// --- response unwrapping ------------------------------------------------------

test('listsFromResponse accepts a bare array and a { data } wrapper', () => {
  assert.equal(listsFromResponse([{ id: 'report:a' }]).length, 1)
  assert.equal(listsFromResponse({ data: [{ id: 'report:b' }] }).length, 1)
  assert.equal(listsFromResponse(null).length, 0)
})

test('taggedEntitiesFromResponse accepts a bare array and an { entities } wrapper', () => {
  assert.equal(taggedEntitiesFromResponse([{ entity: { id: 'CK2WP' } }]).length, 1)
  assert.equal(taggedEntitiesFromResponse({ entities: [{ entity: { id: 'a' } }, { entity: { id: 'b' } }] }).length, 2)
  assert.equal(taggedEntitiesFromResponse(null).length, 0)
})

// --- tag extraction + matching ------------------------------------------------

test('tagName reads the name, an enum id, or a bare string', () => {
  assert.equal(tagName({ id: 'enum:EntityListTag:tier1', name: 'tier1' }), 'tier1')
  assert.equal(tagName({ id: 'enum:EntityListTag:gdpr' }), 'gdpr')
  assert.equal(tagName('Critical'), 'critical')
})

test('tagsOf collects a row\'s tag names, lowercased', () => {
  const set = tagsOf({ entity: { id: 'CK2WP' }, tags: [{ name: 'Tier1' }, { id: 'enum:EntityListTag:gdpr' }] })
  assert.ok(set.has('tier1'))
  assert.ok(set.has('gdpr'))
  assert.equal(set.size, 2)
})

test('findTaggedEntity matches by id or by name', () => {
  const rows = [
    { entity: { id: 'CK2WP', name: 'Rostelecom' }, tags: [] },
    { entity: { id: 'XY9', name: 'Acme' }, tags: [] },
  ]
  assert.equal(findTaggedEntity(rows, 'id', 'ck2wp')?.entity?.name, 'Rostelecom')
  assert.equal(findTaggedEntity(rows, 'name', 'acme')?.entity?.id, 'XY9')
  assert.equal(findTaggedEntity(rows, 'id', 'nope'), null)
})

// --- sameTagSet ---------------------------------------------------------------

test('sameTagSet is order- and case-insensitive set equality', () => {
  assert.equal(sameTagSet(['tier1', 'gdpr'], ['GDPR', 'Tier1']), true)
  assert.equal(sameTagSet(['tier1'], ['tier1', 'gdpr']), false)
  assert.equal(sameTagSet([], []), true)
})

// --- vocabulary ---------------------------------------------------------------

test('AVAILABLE_TAGS holds the documented sample tags and normalize is stable', () => {
  for (const tag of ['tier1', 'critical', 'gdpr', 'pci_dss', 'pii', 'financial', 'subsidiary']) {
    assert.ok(AVAILABLE_TAGS.has(tag), `expected ${tag} in vocabulary`)
  }
  assert.equal(normalize(' GDPR '), 'gdpr')
})
