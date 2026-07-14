// =============================================================================
// Jest-shaped globals for the app tests, mapped onto node:test + node:assert.
//
// The app tests were written against @types/jest, but no Jest is installed — so
// they only ever typechecked. They use four matchers, no mocks and no hooks, so
// esbuild injects these definitions rather than the repo taking on a whole test
// framework. Add a matcher here if a test needs one.
// =============================================================================

import assert from 'node:assert/strict'
import { describe as nodeDescribe, it as nodeIt } from 'node:test'

/** Fill Jest's printf placeholders (%s, %d, ...) from the row's values. */
function formatTitle(title, args) {
  let i = 0
  return String(title).replace(/%[sdifjo%]/g, (token) =>
    token === '%%' ? '%' : String(args[i++]),
  )
}

/**
 * node:test has no `.each`, and calling it throws mid-registration — which
 * silently CANCELS every test already registered in that suite. Support it.
 */
function withEach(register) {
  const wrapped = (...args) => register(...args)
  wrapped.each = (rows) => (title, fn) => {
    for (const row of rows) {
      const args = Array.isArray(row) ? row : [row]
      register(formatTitle(title, args), () => fn(...args))
    }
  }
  wrapped.only = register.only?.bind(register)
  wrapped.skip = register.skip?.bind(register)
  wrapped.todo = register.todo?.bind(register)
  return wrapped
}

export const describe = withEach(nodeDescribe)
export const it = withEach(nodeIt)

export function expect(actual) {
  return {
    toBe: (expected) => assert.strictEqual(actual, expected),
    toEqual: (expected) => assert.deepStrictEqual(actual, expected),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toHaveLength: (length) => {
      assert.ok(actual != null, `expected a value with .length, got ${actual}`)
      assert.strictEqual(actual.length, length)
    },
    /** Membership for an array, substring for a string. */
    toContain: (expected) => {
      assert.ok(actual != null, `expected a value with .includes, got ${actual}`)
      assert.ok(
        actual.includes(expected),
        `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`,
      )
    },
    toMatch: (expected) => {
      const matched =
        expected instanceof RegExp ? expected.test(actual) : String(actual).includes(expected)
      assert.ok(matched, `expected ${JSON.stringify(actual)} to match ${expected}`)
    },
    toBeGreaterThan: (expected) => {
      assert.ok(actual > expected, `expected ${actual} to be greater than ${expected}`)
    },
  }
}
