import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  readUsers,
  findUser,
  parseRoles,
  userCreateVQL,
  userGrantVQL,
  userDeleteVQL,
  GUI_USERS_VQL,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { name: 'analyst@example.com', roles: 'reader, analyst', password: '' }

// --- validate -----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate requires at least one role', async () => {
  const res = await validate(ctxOf([{ ...good, roles: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ROLES'))
})

test('validate warns on an unknown role', async () => {
  const res = await validate(ctxOf([{ ...good, roles: 'reader, wizard' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNKNOWN_ROLE'))
})

test('validate warns on a duplicate name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'Analyst@Example.com' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good user', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- helpers ------------------------------------------------------------------

test('parseRoles splits CSV roles', () => {
  assert.deepEqual(parseRoles('reader, analyst,investigator'), ['reader', 'analyst', 'investigator'])
})

test('readUsers reads name + roles tolerant of casing and array/CSV', () => {
  const users = readUsers([
    { name: 'a@x.com', roles: ['reader', 'analyst'] },
    { Name: 'b@x.com', Roles: 'administrator' },
    { name: '' },
  ])
  assert.equal(users.length, 2)
  assert.deepEqual(users[0], { name: 'a@x.com', roles: ['reader', 'analyst'] })
  assert.deepEqual(users[1], { name: 'b@x.com', roles: ['administrator'] })
})

test('findUser matches by case-insensitive name', () => {
  const live = readUsers([{ name: 'A@X.com', roles: ['reader'] }])
  assert.equal(findUser(live, 'a@x.com')?.name, 'A@X.com')
  assert.equal(findUser(live, 'missing'), null)
})

// --- VQL builders -------------------------------------------------------------

test('userCreateVQL renders roles as a VQL array and includes a password when given', () => {
  const vql = userCreateVQL('a@x.com', ['reader', 'analyst'], 'secret')
  assert.match(vql, /user_create\(user='a@x\.com', roles=\['reader', 'analyst'\], password='secret'\)/)
})

test('userCreateVQL omits the password argument when none is given', () => {
  const vql = userCreateVQL('a@x.com', ['reader'])
  assert.match(vql, /user_create\(user='a@x\.com', roles=\['reader'\]\)/)
  assert.ok(!/password=/.test(vql))
})

test('userGrantVQL / userDeleteVQL name the user', () => {
  assert.match(userGrantVQL('a@x.com', ['reader']), /user_grant\(user='a@x\.com', roles=\['reader'\]\)/)
  assert.match(userDeleteVQL('a@x.com'), /user_delete\(user='a@x\.com'\)/)
})

test('userCreateVQL escapes single quotes in inputs', () => {
  const vql = userCreateVQL("o'brien", ['reader'], "pa'ss")
  assert.match(vql, /user='o''brien'/)
  assert.match(vql, /password='pa''ss'/)
})

test('GUI_USERS_VQL selects from gui_users()', () => {
  assert.match(GUI_USERS_VQL, /FROM gui_users\(\)/)
})
