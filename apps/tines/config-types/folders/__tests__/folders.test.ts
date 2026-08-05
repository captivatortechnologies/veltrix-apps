import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractFolderSpecs, buildFolderBody, findFolder, findFolderByName } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Phishing', team_id: '1', content_type: 'STORY' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid folder', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name/team/content_type', async () => {
  const res = await validate(ctxOf([{ name: '', team_id: '', content_type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEAM'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONTENT_TYPE'))
})

test('validate rejects an invalid content_type', async () => {
  const res = await validate(ctxOf([{ ...good, content_type: 'BOGUS' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONTENT_TYPE'))
})

test('validate rejects a folder that is its own parent', async () => {
  const res = await validate(ctxOf([{ ...good, parent_folder_name: 'Phishing' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SELF_PARENT'))
})

test('validate warns on a duplicate (team, content type, parent, name)', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate allows the same name in a different content type', async () => {
  const res = await validate(ctxOf([good, { ...good, content_type: 'CREDENTIAL' }]))
  assert.equal(res.warnings.length, 0)
})

test('extractFolderSpecs trims fields', () => {
  const specs = extractFolderSpecs(ctxOf([{ name: '  Phishing  ', team_id: ' 1 ', content_type: 'STORY' }]).canvas)
  assert.equal(specs[0].name, 'Phishing')
  assert.equal(specs[0].teamId, '1')
})

test('buildFolderBody includes the resolved parent id', () => {
  const body = buildFolderBody({ itemName: 'i', name: 'Sub', teamId: '1', contentType: 'STORY', parentFolderName: 'Parent' }, '42')
  assert.equal(body.parent_folder_id, '42')
  assert.equal(body.name, 'Sub')
})

test('findFolder matches within the same scope only', () => {
  const live = [
    { id: 1, team_id: '1', content_type: 'STORY', name: 'Phishing', parent_folder_id: null },
    { id: 2, team_id: '1', content_type: 'CREDENTIAL', name: 'Phishing', parent_folder_id: null },
  ]
  const found = findFolder(live, { teamId: '1', contentType: 'STORY', name: 'phishing' }, null)
  assert.equal(found?.id, 1)
  assert.equal(findFolder(live, { teamId: '2', contentType: 'STORY', name: 'phishing' }, null), null)
})

test('findFolderByName ignores parent scoping', () => {
  const live = [{ id: 5, team_id: '1', content_type: 'STORY', name: 'Parent', parent_folder_id: null }]
  assert.equal(findFolderByName(live, '1', 'STORY', 'parent')?.id, 5)
})
