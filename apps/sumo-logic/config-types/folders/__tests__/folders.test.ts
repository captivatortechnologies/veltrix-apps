import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildFolderCreateBody, buildFolderUpdateBody, findFolderChild, type ContentChild } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Security Dashboards', parentId: '000000000C1C17C6', description: 'Team dashboards' }

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed folder', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing parentId', async () => {
  const res = await validate(ctxOf([{ ...good, parentId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PARENT_ID'))
})

test('validate warns on a duplicate (parentId, name) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('buildFolderCreateBody includes parentId', () => {
  const body = buildFolderCreateBody(good)
  assert.equal(body.parentId, '000000000C1C17C6')
  assert.equal(body.name, 'Security Dashboards')
})

test('buildFolderUpdateBody never includes parentId', () => {
  const body = buildFolderUpdateBody(good)
  assert.equal('parentId' in body, false)
})

test('findFolderChild matches Folder-type children by name, ignores other content types', () => {
  const children: ContentChild[] = [
    { id: '1', name: 'Security Dashboards', itemType: 'Folder' },
    { id: '2', name: 'Security Dashboards', itemType: 'Dashboard' },
  ]
  assert.equal(findFolderChild(children, 'security dashboards')?.id, '1')
  assert.equal(findFolderChild(children, 'missing'), null)
  assert.equal(findFolderChild(undefined, 'x'), null)
})
