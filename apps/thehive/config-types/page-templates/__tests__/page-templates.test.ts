import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildPageTemplateCreateBody,
  buildPageTemplateUpdateBody,
  toPageTemplateUpdate,
  findPageTemplate,
  pageTemplateId,
  parseOrder,
  pageTemplatesFromList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the TheHive REST API (node:https inside
 * thehiveApi), impractical to mock here. Tests cover validate.ts and the pure
 * network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { title: 'Phishing Triage Checklist', category: 'Investigation', content: '## Steps\n1. Verify sender', order: 1 }

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects a missing category', async () => {
  const res = await validate(ctxOf([{ ...good, category: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CATEGORY'))
})

test('validate rejects missing content', async () => {
  const res = await validate(ctxOf([{ ...good, content: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONTENT'))
})

test('validate warns on a duplicate title', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate accepts a good page template', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('parseOrder falls back to 0 for negative/non-numeric input', () => {
  assert.equal(parseOrder(3), 3)
  assert.equal(parseOrder('7'), 7)
  assert.equal(parseOrder(-1), 0)
  assert.equal(parseOrder('bogus'), 0)
  assert.equal(parseOrder(undefined), 0)
})

test('buildPageTemplateCreateBody carries every field', () => {
  const body = buildPageTemplateCreateBody(good)
  assert.deepEqual(body, { title: 'Phishing Triage Checklist', category: 'Investigation', content: '## Steps\n1. Verify sender', order: 1 })
})

test('buildPageTemplateUpdateBody omits title', () => {
  const body = buildPageTemplateUpdateBody(good)
  assert.ok(!('title' in body))
  assert.equal(body.category, 'Investigation')
  assert.equal(body.order, 1)
})

test('toPageTemplateUpdate maps a live template to its mutable subset', () => {
  const body = toPageTemplateUpdate({ _id: 'abc', title: 'x', content: 'c', category: 'Remediation', order: 2 })
  assert.deepEqual(body, { content: 'c', category: 'Remediation', order: 2 })
})

test('findPageTemplate matches by title; pageTemplateId prefers _id then id', () => {
  const live = [{ _id: 'abc', title: 'Phishing Triage Checklist' }, { id: 5, title: 'Malware Runbook' }]
  assert.equal(pageTemplateId(findPageTemplate(live, 'Phishing Triage Checklist')), 'abc')
  assert.equal(pageTemplateId(findPageTemplate(live, 'Malware Runbook')), '5')
  assert.equal(findPageTemplate(live, 'nope'), null)
})

test('pageTemplatesFromList unwraps arrays and wrapped rows', () => {
  assert.equal(pageTemplatesFromList([{ title: 'a' }]).length, 1)
  assert.equal(pageTemplatesFromList({ data: [{ title: 'a' }] }).length, 1)
  assert.equal(pageTemplatesFromList(null).length, 0)
})
