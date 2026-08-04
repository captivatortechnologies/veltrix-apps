import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreateFilterCommand, buildModifyFilterCommand, buildDeleteFilterCommand, parseFilters } from '../../../lib/gmp/filters'
import { buildFilterInput, findFilterByName } from '../_shared'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'Single Targets', type: 'target', term: 'ips=1 first=1 rows=-2', comment: 'ops' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate filter name', async () => {
  const res = await validate(ctxOf([good, { ...good, term: 'ips=2' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a filter with no term (match-all)', async () => {
  const res = await validate(ctxOf([{ ...good, term: '' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- command builders --------------------------------------------------------

test('buildCreateFilterCommand emits name, term, type and comment', () => {
  const xml = buildCreateFilterCommand(good)
  assert.ok(xml.includes('<name>Single Targets</name>'))
  assert.ok(xml.includes('<term>ips=1 first=1 rows=-2</term>'))
  assert.ok(xml.includes('<type>target</type>'))
  assert.ok(xml.includes('<comment>ops</comment>'))
})

test('buildModifyFilterCommand targets by filter_id and only sends provided fields', () => {
  const xml = buildModifyFilterCommand('f1', { term: 'rows=-1' })
  assert.equal(xml, '<modify_filter filter_id="f1"><term>rows=-1</term></modify_filter>')
})

test('buildDeleteFilterCommand sets ultimate', () => {
  assert.equal(buildDeleteFilterCommand('f1', true), '<delete_filter filter_id="f1" ultimate="1"/>')
})

// --- response parsing ---------------------------------------------------------

test('parseFilters extracts id, name, type and term', () => {
  const xml = '<get_filters_response><filter id="f1"><name>Single Targets</name><type>target</type><term>ips=1</term></filter></get_filters_response>'
  const [f] = parseFilters(xml)
  assert.equal(f.id, 'f1')
  assert.equal(f.type, 'target')
  assert.equal(f.term, 'ips=1')
})

// --- _shared helpers -----------------------------------------------------------

test('buildFilterInput trims fields', () => {
  const input = buildFilterInput({ name: '  Single Targets  ', term: '  ips=1  ' })
  assert.equal(input.name, 'Single Targets')
  assert.equal(input.term, 'ips=1')
})

test('findFilterByName matches on the trimmed name', () => {
  const filters = parseFilters('<get_filters_response><filter id="f1"><name>Single Targets</name></filter></get_filters_response>')
  assert.equal(findFilterByName(filters, 'Single Targets')?.id, 'f1')
  assert.equal(findFilterByName(filters, 'Nope'), null)
})
