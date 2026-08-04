import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractUserSpecs, buildUserBody, userRestoreBody, findUser, isPlausibleEmail } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure _shared
// helpers (extraction / body building), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Earline Greenholt', email: 'earline@example.com', role: 'admin', job_title: 'Director', time_zone: 'America/New_York', color: 'green' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid user', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a user with only name + email', async () => {
  const res = await validate(ctxOf([{ name: 'Kyler Kuhn', email: 'kyler@example.com' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing email', async () => {
  const res = await validate(ctxOf([{ ...good, email: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EMAIL'))
})

test('validate rejects a malformed email', async () => {
  const res = await validate(ctxOf([{ ...good, email: 'not-an-email' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EMAIL'))
})

test('validate rejects an invalid role', async () => {
  const res = await validate(ctxOf([{ ...good, role: 'super_admin' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROLE'))
})

test('validate rejects an invalid color', async () => {
  const res = await validate(ctxOf([{ ...good, color: 'neon-pink' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COLOR'))
})

test('validate warns on a duplicate email', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'Earline G.' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_EMAIL'))
})

test('isPlausibleEmail accepts a plausible address and rejects garbage', () => {
  assert.equal(isPlausibleEmail('earline@example.com'), true)
  assert.equal(isPlausibleEmail('not-an-email'), false)
  assert.equal(isPlausibleEmail('missing-domain@'), false)
  assert.equal(isPlausibleEmail('@no-local.com'), false)
  assert.equal(isPlausibleEmail('trailing-dot@example.'), false)
})

test('extractUserSpecs trims fields and carries optional profile fields', () => {
  const specs = extractUserSpecs(ctxOf([{ name: '  Earline  ', email: '  earline@example.com  ', role: 'admin' }]).canvas)
  assert.equal(specs[0].name, 'Earline')
  assert.equal(specs[0].email, 'earline@example.com')
  assert.equal(specs[0].role, 'admin')
  assert.equal(specs[0].jobTitle, '')
})

test('buildUserBody sets the type and omits unset optional fields', () => {
  const body = buildUserBody({ itemName: 'g', name: 'Kyler Kuhn', email: 'kyler@example.com', role: '', jobTitle: '', timeZone: '', description: '', color: '' })
  assert.equal(body.type, 'user')
  assert.equal(body.name, 'Kyler Kuhn')
  assert.equal(body.email, 'kyler@example.com')
  assert.equal(body.role, undefined)
  assert.equal(body.job_title, undefined)
  assert.equal(body.time_zone, undefined)
  assert.equal(body.color, undefined)
})

test('buildUserBody includes optional fields when present', () => {
  const body = buildUserBody({
    itemName: 'g',
    name: 'Earline Greenholt',
    email: 'earline@example.com',
    role: 'admin',
    jobTitle: 'Director of Engineering',
    timeZone: 'America/Lima',
    description: 'The boss',
    color: 'green',
  })
  assert.equal(body.role, 'admin')
  assert.equal(body.job_title, 'Director of Engineering')
  assert.equal(body.time_zone, 'America/Lima')
  assert.equal(body.description, 'The boss')
  assert.equal(body.color, 'green')
})

test('userRestoreBody reconstructs the prior body', () => {
  const body = userRestoreBody({ id: 'PXPGF42', name: 'Earline Greenholt', email: 'earline@example.com', role: 'admin', color: 'green' })
  assert.equal(body.type, 'user')
  assert.equal(body.name, 'Earline Greenholt')
  assert.equal(body.email, 'earline@example.com')
  assert.equal(body.role, 'admin')
  assert.equal(body.color, 'green')
})

test('findUser matches by email case-insensitively', () => {
  const live = [{ id: 'PXPGF42', email: 'Earline@Example.com' }, { id: 'PAM4FGS', email: 'kyler@example.com' }]
  assert.equal(findUser(live, 'earline@example.com')?.id, 'PXPGF42')
  assert.equal(findUser(live, 'missing@example.com'), null)
})
