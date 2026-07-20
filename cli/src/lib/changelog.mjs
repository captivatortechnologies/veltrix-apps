// ============================================================================
// CHANGELOG.md parsing (single source of truth)
//
// Shared by the validator (enforces a documented entry per version) and the
// marketplace catalog builder (feeds releaseNotes/releasedAt to the platform's
// in-product upgrade banner). "Keep a Changelog" style: each release is a
// level-2 heading whose text carries the semver, e.g.
//
//   ## 1.7.0 — 2026-07-20
//   - Grouped the Configurations sidebar into collapsible sections
//
// The body runs until the next `## ` heading or end of file.
// ============================================================================

import fs from 'node:fs'

const HEADING_RE = /^##\s+(.*\S)\s*$/
const SEMVER_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/
const DATE_RE = /(\d{4}-\d{2}-\d{2})/

/**
 * Parse a changelog into a Map<version, { heading, date, notes }>. Only H2
 * headings that contain a semver start a release section; anything else (an
 * "Unreleased" header with no version, the file title) is skipped.
 */
export function parseChangelog(text) {
  const lines = String(text).split('\n')
  const sections = new Map()
  let current = null

  const flush = () => {
    if (!current) return
    sections.set(current.version, {
      heading: current.heading,
      date: current.date,
      notes: current.body.join('\n').trim(),
    })
  }

  for (const line of lines) {
    const h = line.match(HEADING_RE)
    if (h) {
      flush()
      const headingText = h[1]
      const v = headingText.match(SEMVER_RE)
      if (v) {
        const d = headingText.match(DATE_RE)
        current = { version: v[1], heading: headingText, date: d ? d[1] : null, body: [] }
      } else {
        current = null
      }
      continue
    }
    if (current) current.body.push(line)
  }
  flush()
  return sections
}

/**
 * The release notes for one version as markdown (heading + body), plus the
 * release date when the heading carries one. Returns null when the version has
 * no section. The heading is preserved so the upgrade banner shows the version.
 */
export function changelogEntry(text, version) {
  const entry = parseChangelog(text).get(version)
  if (!entry) return null
  const notes = `## ${entry.heading}${entry.notes ? `\n\n${entry.notes}` : ''}`.trim()
  return { notes, date: entry.date }
}

/** File-reading convenience wrapper; null when the file is missing/unreadable. */
export function readChangelogEntry(changelogPath, version) {
  if (!fs.existsSync(changelogPath)) return null
  try {
    return changelogEntry(fs.readFileSync(changelogPath, 'utf8'), version)
  } catch {
    return null
  }
}
