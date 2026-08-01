import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildCaseTemplateBody, parseTags, parseTasks, toBoundedInt, findCaseTemplate, templateId } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the TheHive REST API via
 * node:https inside thehiveApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Phishing Investigation', displayName: 'Phishing', severity: '2', tlp: '2', pap: '2', tags: 'phishing, email', description: 'Triage phishing', tasks: 'Triage\nContain' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an out-of-range severity', async () => {
  const res = await validate(ctxOf([{ ...good, severity: '9' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEVERITY'))
})

test('validate rejects an out-of-range tlp', async () => {
  const res = await validate(ctxOf([{ ...good, tlp: '7' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TLP'))
})

test('validate rejects an out-of-range pap', async () => {
  const res = await validate(ctxOf([{ ...good, pap: '-1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PAP'))
})

test('validate warns on a duplicate template name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good template', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('toBoundedInt clamps and falls back', () => {
  assert.equal(toBoundedInt('3', 1, 4, 2), 3)
  assert.equal(toBoundedInt('9', 1, 4, 2), 4)
  assert.equal(toBoundedInt('0', 1, 4, 2), 1)
  assert.equal(toBoundedInt('nope', 1, 4, 2), 2)
})

test('parseTags splits on newlines and commas, dedupes', () => {
  assert.deepEqual(parseTags('phishing, email\nphishing\n  malware '), ['phishing', 'email', 'malware'])
  assert.deepEqual(parseTags(''), [])
})

test('parseTasks yields one task object per non-empty line, deduped', () => {
  assert.deepEqual(parseTasks('Triage\n\nContain\nTriage'), [{ title: 'Triage' }, { title: 'Contain' }])
})

test('buildCaseTemplateBody coerces enums and defaults displayName to name', () => {
  const body = buildCaseTemplateBody({ name: 'IR', severity: '3', tlp: '1', pap: '0', tags: 'a,b', tasks: 'X' })
  assert.equal(body.name, 'IR')
  assert.equal(body.displayName, 'IR')
  assert.equal(body.severity, 3)
  assert.equal(body.tlp, 1)
  assert.equal(body.pap, 0)
  assert.deepEqual(body.tags, ['a', 'b'])
  assert.deepEqual(body.tasks, [{ title: 'X' }])
})

test('findCaseTemplate matches by name; templateId prefers _id then id', () => {
  const live = [{ _id: 'abc', name: 'IR' }, { id: 7, name: 'Phish' }]
  assert.equal(templateId(findCaseTemplate(live, 'IR')), 'abc')
  assert.equal(templateId(findCaseTemplate(live, 'Phish')), '7')
  assert.equal(findCaseTemplate(live, 'nope'), null)
})
