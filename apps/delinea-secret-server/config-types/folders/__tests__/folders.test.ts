import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractFolderSpecs,
  findFolderByNameAndParent,
  foldersFromResponse,
  buildFolderCreateBody,
  buildFolderUpdateBody,
  normalizeBool,
  ROOT_PARENT_FOLDER_ID,
  DEFAULT_FOLDER_TYPE_ID,
  type LiveFolder,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Secret Server REST API via
 * node:https inside secretServerApi, which is impractical to mock here. Tests
 * cover validate.ts and the pure, network-free helpers in _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.folderName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { folderName: 'Databases', parentFolderName: 'Infrastructure', inheritPermissions: true, inheritSecretPolicy: true, comment: 'db creds' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing folder name', async () => {
  const res = await validate(ctxOf([{ ...good, folderName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a good folder', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a missing (optional) parent folder — root placement', async () => {
  const res = await validate(ctxOf([{ ...good, parentFolderName: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name under the same parent', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_FOLDER'))
})

test('validate allows the same name under different parents', async () => {
  const res = await validate(ctxOf([good, { ...good, parentFolderName: 'Applications' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('validate rejects a name longer than 255 characters', async () => {
  const res = await validate(ctxOf([{ ...good, folderName: 'x'.repeat(256) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeBool coerces booleans, strings and numbers', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('1'), true)
  assert.equal(normalizeBool('yes'), true)
  assert.equal(normalizeBool(false), false)
  assert.equal(normalizeBool('no'), false)
  assert.equal(normalizeBool(undefined), false)
})

test('extractFolderSpecs maps and trims canvas fields', () => {
  const specs = extractFolderSpecs(toItems([{ folderName: '  Databases  ', parentFolderName: ' Infra ', inheritPermissions: false, inheritSecretPolicy: true }]))
  assert.equal(specs[0].folderName, 'Databases')
  assert.equal(specs[0].parentFolderName, 'Infra')
  assert.equal(specs[0].inheritPermissions, false)
  assert.equal(specs[0].inheritSecretPolicy, true)
})

test('foldersFromResponse parses a paginated envelope and a bare array', () => {
  const env = foldersFromResponse(JSON.stringify({ records: [{ id: 1, folderName: 'A' }], total: 1 }))
  assert.equal(env.records.length, 1)
  assert.equal(env.total, 1)
  const arr = foldersFromResponse(JSON.stringify([{ id: 2, folderName: 'B' }]))
  assert.equal(arr.records.length, 1)
  assert.equal(foldersFromResponse('not json').records.length, 0)
})

test('findFolderByNameAndParent matches case-insensitively within a parent', () => {
  const folders: LiveFolder[] = [
    { id: 1, folderName: 'Databases', parentFolderId: 5 },
    { id: 2, folderName: 'Databases', parentFolderId: 9 },
  ]
  assert.equal(findFolderByNameAndParent(folders, 'databases', 9)?.id, 2)
  assert.equal(findFolderByNameAndParent(folders, 'Databases', 5)?.id, 1)
  assert.equal(findFolderByNameAndParent(folders, 'Databases', 99), null)
})

test('buildFolderCreateBody sets the folder type and parent', () => {
  const spec = extractFolderSpecs(toItems([good]))[0]
  const body = buildFolderCreateBody(spec, ROOT_PARENT_FOLDER_ID)
  assert.equal(body.folderName, 'Databases')
  assert.equal(body.folderTypeId, DEFAULT_FOLDER_TYPE_ID)
  assert.equal(body.parentFolderId, ROOT_PARENT_FOLDER_ID)
  assert.equal(body.inheritPermissions, true)
  assert.equal(body.inheritSecretPolicy, true)
})

test('buildFolderUpdateBody carries the id and managed fields', () => {
  const spec = extractFolderSpecs(toItems([{ ...good, inheritPermissions: false }]))[0]
  const body = buildFolderUpdateBody(spec, { id: 42, folderName: 'Databases', folderTypeId: 1 })
  assert.equal(body.id, 42)
  assert.equal(body.folderName, 'Databases')
  assert.equal(body.inheritPermissions, false)
  assert.equal(body.folderTypeId, 1)
})
