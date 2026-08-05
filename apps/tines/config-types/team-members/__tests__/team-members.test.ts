import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractTeamMemberSpecs, buildInviteBody, findMember, isValidEmail } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.email ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { team_id: '1', email: 'analyst@example.com', role: 'EDITOR' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid member', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing team/email', async () => {
  const res = await validate(ctxOf([{ team_id: '', email: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEAM'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EMAIL'))
})

test('validate rejects a malformed email', async () => {
  const res = await validate(ctxOf([{ ...good, email: 'not-an-email' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EMAIL'))
})

test('validate warns on a duplicate (team, email)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_MEMBER'))
})

test('extractTeamMemberSpecs lowercases the email', () => {
  const specs = extractTeamMemberSpecs(ctxOf([{ team_id: '1', email: 'Analyst@Example.com' }]).canvas)
  assert.equal(specs[0].email, 'analyst@example.com')
})

test('buildInviteBody omits role when blank', () => {
  assert.deepEqual(buildInviteBody({ itemName: 'i', teamId: '1', email: 'a@b.com', role: '' }), { email: 'a@b.com' })
  assert.deepEqual(buildInviteBody({ itemName: 'i', teamId: '1', email: 'a@b.com', role: 'VIEWER' }), { email: 'a@b.com', role: 'VIEWER' })
})

test('findMember matches by email case-insensitively', () => {
  const live = [{ id: 1, email: 'Analyst@Example.com' }]
  assert.equal(findMember(live, 'analyst@example.com')?.id, 1)
  assert.equal(findMember(live, 'missing@example.com'), null)
})

test('isValidEmail', () => {
  assert.equal(isValidEmail('a@b.com'), true)
  assert.equal(isValidEmail('not-an-email'), false)
})
