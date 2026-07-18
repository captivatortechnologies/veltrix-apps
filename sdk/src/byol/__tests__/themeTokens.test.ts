import { describe, it, expect } from 'vitest'
import { tokens } from '../detail/shared'

// These tokens are the seam through which every BYOL detail surface inherits the
// platform's light/dark theme (client/src/styles/tokens.css). Two mistakes
// silently break dark mode, and both are easy to reintroduce, so pin them:
//   1. Referencing a variable that doesn't exist (the `--color-text*` /
//      `--color-surface-secondary` names never existed) → falls back to a
//      hardcoded LIGHT hex forever.
//   2. Using a design token (a space-separated RGB triple) as a bare colour
//      instead of wrapping it in `rgb(...)` → invalid CSS, silently dropped.

describe('BYOL detail theme tokens', () => {
  it('binds text + surface to the real platform variables (so dark mode flips)', () => {
    expect(tokens.text).toContain('--color-content-primary')
    expect(tokens.muted).toContain('--color-content-secondary')
    expect(tokens.faint).toContain('--color-content-tertiary')
    expect(tokens.surface).toContain('--color-surface-raised')
    expect(tokens.surface2).toContain('--color-surface')
    expect(tokens.border).toContain('--color-border')
    expect(tokens.borderStrong).toContain('--color-border-strong')
  })

  it('never references the non-existent legacy variable names', () => {
    const dead = ['--color-text', '--color-text-muted', '--color-text-subtle', '--color-surface-secondary']
    for (const value of Object.values(tokens)) {
      for (const name of dead) {
        // `--color-text` is a prefix of `--color-text-muted`, so match the exact
        // token boundary (var name terminates with `,` or `)`).
        expect(value).not.toMatch(new RegExp(`${name}[,)]`))
      }
    }
  })

  it('wraps every RGB-triple design token in rgb() so it is valid CSS', () => {
    const tripleTokens = ['border', 'borderStrong', 'surface', 'surface2', 'text', 'muted', 'faint', 'danger', 'success', 'info', 'warning'] as const
    for (const key of tripleTokens) {
      const value = tokens[key]
      expect(value.startsWith('rgb(')).toBe(true)
      // Fallback inside var() must itself be a bare RGB triple, e.g. `17 24 39`.
      expect(value).toMatch(/,\s*\d+\s+\d+\s+\d+\)\)$/)
    }
  })

  it('keeps primary on the host-injected hex brand variable (not a triple)', () => {
    expect(tokens.primary).toBe('var(--veltrix-app-primary, #FF6600)')
  })
})
