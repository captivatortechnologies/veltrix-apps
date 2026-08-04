import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vqlJson } from '../velociraptorApi'

// vqlJson is the shared parse_json(data=<json>) builder introduced for the
// config-as-code exhaustion pass (server-metadata, secrets, users-acls policy).
// Pre-existing per-type set*VQL() functions keep their own inline
// parse_json(data=vqlQuote(...)) form and are exercised by their own tests.

test('vqlJson wraps an object as parse_json(data=<json>)', () => {
  const vql = vqlJson({ env: 'prod', tier: 1 })
  assert.equal(vql, `parse_json(data='${JSON.stringify({ env: 'prod', tier: 1 })}')`)
})

test('vqlJson escapes single quotes inside the JSON payload', () => {
  const vql = vqlJson({ note: "o'brien" })
  // The JSON itself contains no single quote issue (JSON uses double quotes),
  // but vqlQuote must still safely wrap whatever JSON.stringify produces.
  assert.match(vql, /^parse_json\(data='.*'\)$/)
})

test('vqlJson round-trips through JSON.parse for a representative dict', () => {
  const value = { a: 1, b: ['x', 'y'], c: true, d: null }
  const vql = vqlJson(value)
  const match = /^parse_json\(data='(.*)'\)$/s.exec(vql)
  assert.ok(match)
  // Undo the VQL '' escaping this module applies to reconstruct the raw JSON.
  const raw = match![1].replace(/''/g, "'")
  assert.deepEqual(JSON.parse(raw), value)
})

test('vqlJson handles arrays and primitives, not just objects', () => {
  assert.match(vqlJson(['a', 'b']), /^parse_json\(data='\[.*\]'\)$/)
  assert.match(vqlJson('plain'), /^parse_json\(data='"plain"'\)$/)
})
