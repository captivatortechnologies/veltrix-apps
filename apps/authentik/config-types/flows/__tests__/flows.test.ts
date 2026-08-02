import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  AUTHENTICATION_REQUIREMENTS,
  buildCreateBody,
  buildPatchBody,
  FLOW_DESIGNATIONS,
  managedFieldsToPatchBody,
  readManagedFields,
  sameManagedFields,
  snapshotManagedFields,
  SLUG_PATTERN,
  type AuthentikFlow,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.slug ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Default Authorization Flow',
  slug: 'default-authorization-flow',
  title: 'Authorizing this application',
  designation: 'authorization',
  authentication: 'require_authenticated',
}

// --- validate ----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects a missing slug', async () => {
  const res = await validate(ctxOf([{ ...good, slug: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SLUG'))
})

test('validate rejects a slug with invalid characters', async () => {
  const res = await validate(ctxOf([{ ...good, slug: 'not a slug!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SLUG'))
})

test('validate rejects a missing designation', async () => {
  const res = await validate(ctxOf([{ ...good, designation: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESIGNATION'))
})

test('validate rejects an unknown designation', async () => {
  const res = await validate(ctxOf([{ ...good, designation: 'reticulation' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DESIGNATION'))
})

test('validate accepts every known designation', async () => {
  for (const designation of FLOW_DESIGNATIONS) {
    const res = await validate(ctxOf([{ ...good, designation }]))
    assert.equal(res.valid, true, `expected ${designation} to be valid`)
  }
})

test('validate rejects an unknown authentication requirement', async () => {
  const res = await validate(ctxOf([{ ...good, authentication: 'require_dance' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_AUTHENTICATION'))
})

test('validate accepts every known authentication requirement, and a blank one', async () => {
  for (const authentication of [...AUTHENTICATION_REQUIREMENTS, '']) {
    const res = await validate(ctxOf([{ ...good, authentication }]))
    assert.equal(res.valid, true, `expected "${authentication}" to be valid`)
  }
})

test('validate warns on a duplicate slug', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'Copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_SLUG'))
})

test('validate accepts a fully populated flow', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ---------------------------------------------------------

test("SLUG_PATTERN matches authentik's Flow.slug pattern", () => {
  assert.equal(SLUG_PATTERN.test('default-authorization-flow'), true)
  assert.equal(SLUG_PATTERN.test('not a slug'), false)
})

test('readManagedFields trims every field', () => {
  const managed = readManagedFields({ ...good, name: '  Default  ' })
  assert.equal(managed.name, 'Default')
  assert.equal(managed.designation, 'authorization')
})

test('buildCreateBody includes the slug alongside the managed fields', () => {
  const body = buildCreateBody('default-authorization-flow', good) as Record<string, unknown>
  assert.equal(body.slug, 'default-authorization-flow')
  assert.equal(body.title, 'Authorizing this application')
  assert.equal(body.authentication, 'require_authenticated')
})

test('buildCreateBody omits authentication when blank', () => {
  const body = buildCreateBody('default-authorization-flow', { ...good, authentication: '' }) as Record<string, unknown>
  assert.equal('authentication' in body, false)
})

test('buildPatchBody never includes the slug', () => {
  const body = buildPatchBody(good) as Record<string, unknown>
  assert.equal('slug' in body, false)
  assert.equal(body.designation, 'authorization')
})

test('snapshotManagedFields reads a live Flow', () => {
  const live: AuthentikFlow = {
    pk: 'uuid-1',
    name: 'Default Authorization Flow',
    slug: 'default-authorization-flow',
    title: 'Authorizing this application',
    designation: 'authorization',
    authentication: 'require_authenticated',
  }
  const snap = snapshotManagedFields(live)
  assert.equal(snap.designation, 'authorization')
  assert.equal(snap.authentication, 'require_authenticated')
})

test('sameManagedFields ignores a live authentication value when none was declared', () => {
  const expected = readManagedFields({ ...good, authentication: '' })
  const actual = snapshotManagedFields({
    name: 'Default Authorization Flow',
    title: 'Authorizing this application',
    designation: 'authorization',
    authentication: 'none',
  })
  assert.equal(sameManagedFields(expected, actual), true)
})

test('sameManagedFields flags a declared authentication value that changed', () => {
  const expected = readManagedFields(good)
  const actual = snapshotManagedFields({
    name: 'Default Authorization Flow',
    title: 'Authorizing this application',
    designation: 'authorization',
    authentication: 'none',
  })
  assert.equal(sameManagedFields(expected, actual), false)
})

test('managedFieldsToPatchBody round-trips a captured snapshot', () => {
  const managed = readManagedFields(good)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.equal(body.title, 'Authorizing this application')
  assert.equal('slug' in body, false)
})
