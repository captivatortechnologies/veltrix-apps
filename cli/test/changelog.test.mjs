// ============================================================================
// Changelog parser tests — the single source of truth for CHANGELOG.md parsing
// used by both the validator (entry-per-version rule) and the marketplace
// catalog builder (releaseNotes / releasedAt).
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChangelog, changelogEntry } from '../src/lib/changelog.mjs'

const SAMPLE = `# Changelog

Some preamble that is not a release.

## 1.2.0 — 2026-07-20

### Changed
- Grouped the sidebar into sections.
- Persisted the open/closed choice.

## 1.1.0 — 2026-01-05

- First public release.
`

test('parseChangelog keys sections by version with date and bounded notes', () => {
  const sections = parseChangelog(SAMPLE)
  assert.deepEqual([...sections.keys()], ['1.2.0', '1.1.0'])

  const v120 = sections.get('1.2.0')
  assert.equal(v120.date, '2026-07-20')
  // The body runs to the next heading and no further.
  assert.ok(v120.notes.includes('Grouped the sidebar into sections.'))
  assert.ok(v120.notes.includes('Persisted the open/closed choice.'))
  assert.ok(!v120.notes.includes('First public release.'))
})

test('changelogEntry returns heading + body markdown and the date', () => {
  const entry = changelogEntry(SAMPLE, '1.2.0')
  assert.ok(entry)
  assert.equal(entry.date, '2026-07-20')
  assert.ok(entry.notes.startsWith('## 1.2.0 — 2026-07-20'))
  assert.ok(entry.notes.includes('### Changed'))
})

test('changelogEntry returns null for a version with no section', () => {
  assert.equal(changelogEntry(SAMPLE, '9.9.9'), null)
})

test('non-version H2 headings (e.g. Unreleased) are skipped', () => {
  const sections = parseChangelog('## Unreleased\n\n- wip\n\n## 1.0.0 — 2026-02-02\n\n- ship\n')
  assert.deepEqual([...sections.keys()], ['1.0.0'])
})

test('a heading without a date yields a null date', () => {
  const entry = changelogEntry('## 1.0.0\n\n- notes\n', '1.0.0')
  assert.ok(entry)
  assert.equal(entry.date, null)
  assert.ok(entry.notes.includes('- notes'))
})
