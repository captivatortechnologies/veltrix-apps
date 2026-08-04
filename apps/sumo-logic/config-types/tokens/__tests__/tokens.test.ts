import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildTokenCreateBody, buildTokenUpdateBody, findToken, tokensFromList, type Token } from '../_shared'
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

const good = { name: 'ASG Installers', description: 'AWS auto-scaling group installers', status: 'Active' }

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed token', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid status', async () => {
  const res = await validate(ctxOf([{ ...good, status: 'Revoked' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STATUS'))
})

test('validate warns on a duplicate name', async () => {
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

test('buildTokenCreateBody always sets type CollectorRegistration', () => {
  const body = buildTokenCreateBody(good)
  assert.equal(body.type, 'CollectorRegistration')
  assert.equal(body.status, 'Active')
})

test('buildTokenUpdateBody includes the given version', () => {
  const body = buildTokenUpdateBody(good, 3)
  assert.equal(body.version, 3)
})

test('tokensFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const tokens: Token[] = [{ id: '1', name: 'a', status: 'Active' }]
  assert.deepEqual(tokensFromList({ data: tokens }), tokens)
  assert.deepEqual(tokensFromList(tokens), tokens)
  assert.deepEqual(tokensFromList(null), [])
})

test('findToken matches by name case-insensitively', () => {
  const tokens: Token[] = [{ id: '9', name: 'ASG Installers', status: 'Active' }]
  assert.equal(findToken(tokens, 'asg installers')?.id, '9')
  assert.equal(findToken(tokens, 'missing'), null)
})
