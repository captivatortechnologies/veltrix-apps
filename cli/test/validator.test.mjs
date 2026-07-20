// ============================================================================
// Validator tests — fixture apps are built in a temp directory and broken one
// rule at a time. Covers the AppInspect-inspired checks: in-process safety,
// canvas/defaults schemas, packaging hygiene, and secret scanning.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateApp } from '../src/lib/validator.mjs'

const HANDLER = 'export default async function handler() {\n  return null\n}\n'

const MANIFEST = `id: fixture-app
name: Fixture App
version: 1.0.0
vendor: Test
description: Fixture app for validator tests
category: CUSTOM
platform:
  minVersion: "1.0.0"
permissions:
  platform: []
  app:
    - resource: configs
      actions: [read]
      description: test
pipeline:
  configurationTypes:
    - id: configs
      name: Configs
      canvasTemplate: config-types/configs/canvas.yaml
      defaultConfig: config-types/configs/defaults.yaml
      handlers:
        validate: config-types/configs/validate
        deploy: config-types/configs/deploy
        rollback: config-types/configs/rollback
        healthCheck: config-types/configs/healthCheck
        getStatus: config-types/configs/getStatus
      targets:
        componentTypes: [test-component]
        requiresCredential: false
        requiresConnectivity: false
server:
  entry: server/index
  routes:
    prefix: /api/apps/fixture-app
`

const CANVAS = `id: fixture-configs
name: Configs
toolType: fixture-app
entityType: configs
sections:
  - name: General
    fields:
      - key: name
        label: Name
        fieldType: text
        required: true
      - key: mode
        label: Mode
        fieldType: select
        defaultValue: fast
        options:
          - label: Fast
            value: fast
          - label: Safe
            value: safe
`

const DEFAULTS = `General:
  name: ""
  mode: fast
`

// The ITEM form: the template describes ONE object the config creates, and
// `groups` are presentational field groupings inside that one flat record.
const ITEM_CANVAS = `id: fixture-configs
name: Configs
toolType: fixture-app
entityType: configs
item:
  label: Config
  identityField: name
  repeatable: true
  minItems: 1
  maxItems: 50
  groups:
    - name: General
      icon: database
      fields:
        - key: name
          label: Name
          fieldType: text
          required: true
    - name: Sizing
      fields:
        - key: sizeMb
          label: Size (MB)
          fieldType: number
          defaultValue: 100
        - key: mode
          label: Mode
          fieldType: select
          defaultValue: fast
          options:
            - label: Fast
              value: fast
            - label: Safe
              value: safe
`

// Defaults for an item template are FLAT — they seed every new item
const ITEM_DEFAULTS = `name: ""
sizeMb: 100
mode: fast
`

/** Write a minimal valid app into <tmp>/fixture-app and return its path. */
function makeApp(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veltrix-validator-test-'))
  const appDir = path.join(root, 'fixture-app')
  const files = {
    'manifest.yaml': MANIFEST,
    'package.json': JSON.stringify({ name: 'veltrix-app-fixture-app', private: true, version: '1.0.0' }),
    'README.md': '# Fixture',
    'config-types/configs/canvas.yaml': CANVAS,
    'config-types/configs/defaults.yaml': DEFAULTS,
    'config-types/configs/validate.ts': HANDLER,
    'config-types/configs/deploy.ts': HANDLER,
    'config-types/configs/rollback.ts': HANDLER,
    'config-types/configs/healthCheck.ts': HANDLER,
    'config-types/configs/getStatus.ts': HANDLER,
    'server/index.ts': 'export default async function registerRoutes() {}\n',
    ...overrides,
  }
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue
    const full = path.join(appDir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return appDir
}

const errorsMatching = (result, re) => result.errors.filter((e) => re.test(e))
const warningsMatching = (result, re) => result.warnings.filter((w) => re.test(w))

test('valid fixture app passes with no errors', () => {
  const result = validateApp(makeApp())
  assert.deepEqual(result.errors, [])
})

test('package.json version must match manifest.version', () => {
  const result = validateApp(
    makeApp({ 'package.json': JSON.stringify({ name: 'x', version: '2.0.0' }) }),
  )
  assert.equal(errorsMatching(result, /package\.json version/).length, 1)
})

test('forbidden module imports are errors', () => {
  const result = validateApp(
    makeApp({
      'config-types/configs/deploy.ts':
        "import { exec } from 'node:child_process'\n" + HANDLER,
    }),
  )
  assert.equal(errorsMatching(result, /security: .*child_process/).length, 1)
})

test('eval and process.exit are errors, fs import is a warning', () => {
  const result = validateApp(
    makeApp({
      'config-types/configs/deploy.ts':
        "import fs from 'node:fs'\nexport default async function handler() {\n  eval('1')\n  process.exit(1)\n}\n",
    }),
  )
  assert.equal(errorsMatching(result, /uses eval\(\)/).length, 1)
  assert.equal(errorsMatching(result, /process\.exit/).length, 1)
  assert.equal(warningsMatching(result, /security: .*node:fs/).length, 1)
})

test('test files are exempt from in-process safety errors', () => {
  const result = validateApp(
    makeApp({
      'config-types/configs/__tests__/deploy.test.ts': 'process.exit(0)\n',
    }),
  )
  assert.deepEqual(errorsMatching(result, /process\.exit/), [])
})

test('canvas: unknown fieldType and optionless select are errors', () => {
  const badCanvas = CANVAS.replace('fieldType: text', 'fieldType: dropdown').replace(
    /        options:[\s\S]*$/m,
    '',
  )
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': badCanvas }))
  assert.equal(errorsMatching(result, /canvas: .*fieldType must be one of/).length, 1)
  assert.equal(errorsMatching(result, /canvas: .*select but declares no options/).length, 1)
})

test('canvas: invalid validation regex is an error', () => {
  const badCanvas = CANVAS.replace(
    'fieldType: text\n        required: true',
    'fieldType: text\n        required: true\n        validation:\n          pattern: "[unclosed"',
  )
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': badCanvas }))
  assert.equal(errorsMatching(result, /canvas: .*not a valid regex/).length, 1)
})

test('canvas: select defaultValue must be an option value', () => {
  const badCanvas = CANVAS.replace('defaultValue: fast', 'defaultValue: turbo')
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': badCanvas }))
  assert.equal(errorsMatching(result, /canvas: .*"turbo" is not one of its option values/).length, 1)
})

test('defaults referencing unknown sections or fields warn', () => {
  const result = validateApp(
    makeApp({
      'config-types/configs/defaults.yaml': 'Nonexistent:\n  name: ""\nGeneral:\n  ghost: 1\n',
    }),
  )
  assert.equal(warningsMatching(result, /defaults section "Nonexistent"/).length, 1)
  assert.equal(warningsMatching(result, /defaults key "General\.ghost"/).length, 1)
})

// --- ITEM model ---------------------------------------------------------------

test('canvas: item template with groups and flat defaults is accepted', () => {
  const result = validateApp(
    makeApp({
      'config-types/configs/canvas.yaml': ITEM_CANVAS,
      'config-types/configs/defaults.yaml': ITEM_DEFAULTS,
    }),
  )
  assert.deepEqual(result.errors, [])
  assert.deepEqual(warningsMatching(result, /canvas:/), [])
})

test('canvas: legacy sections template is still accepted', () => {
  // The default fixture IS the legacy form — assert it explicitly
  const result = validateApp(makeApp())
  assert.deepEqual(errorsMatching(result, /canvas:/), [])
  assert.deepEqual(warningsMatching(result, /canvas:/), [])
})

test('canvas: a template with neither item nor sections is an error', () => {
  const bare = 'id: fixture-configs\nname: Configs\ntoolType: fixture-app\nentityType: configs\n'
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': bare }))
  assert.equal(errorsMatching(result, /must declare an "item" .* or at least one legacy "section"/).length, 1)
})

test('canvas: duplicate field key across an item\'s groups is an error', () => {
  // `name` is already declared in the General group — an item is one flat
  // record, so redeclaring it in Sizing would collide into a single value
  const dupe = ITEM_CANVAS.replace(
    '        - key: sizeMb\n          label: Size (MB)\n          fieldType: number\n          defaultValue: 100\n',
    '        - key: name\n          label: Name Again\n          fieldType: text\n',
  )
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': dupe }))
  assert.equal(
    errorsMatching(result, /duplicates key "name" — an item is one flat record/).length,
    1,
  )
})

test('canvas: item.identityField must name one of the item\'s fields', () => {
  const bad = ITEM_CANVAS.replace('identityField: name', 'identityField: ghost')
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': bad }))
  assert.equal(
    errorsMatching(result, /item\.identityField "ghost" does not match any field key/).length,
    1,
  )
})

test('canvas: item.identityField that is not required warns', () => {
  const bad = ITEM_CANVAS.replace('          fieldType: text\n          required: true', '          fieldType: text')
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': bad }))
  assert.equal(
    warningsMatching(result, /item\.identityField "name" should be required: true/).length,
    1,
  )
})

test('canvas: identityDerived silences the not-required warning', () => {
  // The handler derives the identity when the user leaves it blank (a Splunk app
  // named after its configuration), so an empty identity is intended.
  const derived = ITEM_CANVAS
    .replace('          fieldType: text\n          required: true', '          fieldType: text')
    .replace('  identityField: name', '  identityField: name\n  identityDerived: true')
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': derived }))
  assert.equal(
    warningsMatching(result, /item\.identityField "name" should be required: true/).length,
    0,
  )
  assert.equal(result.errors.length, 0)
})

test('canvas: identityDerived on a required identity field is an error', () => {
  const bad = ITEM_CANVAS.replace(
    '  identityField: name',
    '  identityField: name\n  identityDerived: true',
  )
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': bad }))
  assert.equal(
    errorsMatching(result, /identityDerived is true but identityField "name" is required/).length,
    1,
  )
})

test('canvas: an item must declare at least one group', () => {
  const bad = 'id: c\nname: C\ntoolType: fixture-app\nentityType: configs\nitem:\n  label: Config\n  groups: []\n'
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': bad }))
  assert.equal(errorsMatching(result, /item must declare at least one group/).length, 1)
})

test('canvas: item minItems/maxItems must be sane integers', () => {
  const bad = ITEM_CANVAS.replace('  minItems: 1\n  maxItems: 50', '  minItems: 5\n  maxItems: 2')
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': bad }))
  assert.equal(errorsMatching(result, /item\.maxItems \(2\) is less than minItems \(5\)/).length, 1)

  const fractional = ITEM_CANVAS.replace('  maxItems: 50', '  maxItems: 2.5')
  const result2 = validateApp(makeApp({ 'config-types/configs/canvas.yaml': fractional }))
  assert.equal(errorsMatching(result2, /item\.maxItems must be an integer/).length, 1)
})

test('canvas: nested (legacy) defaults against an item template warn', () => {
  const result = validateApp(
    makeApp({
      'config-types/configs/canvas.yaml': ITEM_CANVAS,
      'config-types/configs/defaults.yaml': DEFAULTS, // "General:" nesting
    }),
  )
  assert.equal(warningsMatching(result, /defaults key "General" does not match any canvas field/).length, 1)
})

test('canvas: multiselect is a valid fieldType', () => {
  const canvas = ITEM_CANVAS.replace(
    '          fieldType: select\n          defaultValue: fast',
    '          fieldType: multiselect\n          defaultValue: [fast]',
  )
  const result = validateApp(
    makeApp({
      'config-types/configs/canvas.yaml': canvas,
      'config-types/configs/defaults.yaml': ITEM_DEFAULTS,
    }),
  )
  assert.deepEqual(errorsMatching(result, /canvas:/), [])
})

test('canvas: multiselect defaultValue entries must be option values', () => {
  const canvas = ITEM_CANVAS.replace(
    '          fieldType: select\n          defaultValue: fast',
    '          fieldType: multiselect\n          defaultValue: [fast, turbo]',
  )
  const result = validateApp(makeApp({ 'config-types/configs/canvas.yaml': canvas }))
  assert.equal(errorsMatching(result, /"turbo" is not one of its option values/).length, 1)
})

test('settings: select default must be an option value', () => {
  const manifest =
    MANIFEST +
    `settings:
  - key: region
    type: select
    label: Region
    default: mars
    options:
      - label: One
        value: one
`
  const result = validateApp(makeApp({ 'manifest.yaml': manifest }))
  assert.equal(errorsMatching(result, /settings: .*"mars" is not one of its option values/).length, 1)
})

test('duplicate configuration type ids are errors', () => {
  const manifest = MANIFEST.replace(
    'server:\n  entry: server/index',
    `    - id: configs
      name: Configs Again
      canvasTemplate: config-types/configs/canvas.yaml
      handlers:
        validate: config-types/configs/validate
        deploy: config-types/configs/deploy
        rollback: config-types/configs/rollback
        healthCheck: config-types/configs/healthCheck
        getStatus: config-types/configs/getStatus
      targets:
        componentTypes: [test-component]
server:
  entry: server/index`,
  )
  const result = validateApp(makeApp({ 'manifest.yaml': manifest }))
  assert.equal(errorsMatching(result, /"configs" is declared more than once/).length, 1)
})

test('git merge-conflict markers are errors', () => {
  const result = validateApp(
    makeApp({ 'README.md': '# Fixture\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n' }),
  )
  assert.equal(errorsMatching(result, /merge-conflict markers/).length, 1)
})

test('high-confidence secret shapes are errors', () => {
  const result = validateApp(
    makeApp({
      'config-types/configs/deploy.ts':
        "const key = 'AKIAIOSFODNN7EXAMPLE'\n" + HANDLER,
    }),
  )
  assert.equal(errorsMatching(result, /security: .*AWS access key/).length, 1)
})

test('secret-named long literals warn outside tests', () => {
  const result = validateApp(
    makeApp({
      'config-types/configs/deploy.ts':
        "const conf = { client_secret: 'abcdefghijklmnopqrstuvwx' }\n" + HANDLER,
    }),
  )
  assert.equal(warningsMatching(result, /secret-named key/).length, 1)
})

test('symlinks are errors (skipped where symlinks are unavailable)', (t) => {
  const appDir = makeApp()
  try {
    fs.symlinkSync(path.join(appDir, 'README.md'), path.join(appDir, 'link.md'))
  } catch {
    t.skip('cannot create symlinks on this system')
    return
  }
  const result = validateApp(appDir)
  assert.equal(errorsMatching(result, /security: symlinks are not allowed/).length, 1)
})

test('hidden files warn', () => {
  const result = validateApp(makeApp({ '.secret-config': 'x' }))
  assert.equal(warningsMatching(result, /hidden file/).length, 1)
})

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

test('branding: valid colors and logo pass', () => {
  const result = validateApp(
    makeApp({
      'manifest.yaml': MANIFEST + 'branding:\n  primaryColor: "#FC0000"\n  logo: ./assets/logo.svg\n',
      'assets/logo.svg': LOGO_SVG,
    }),
  )
  assert.deepEqual(result.errors, [])
})

test('branding: invalid hex color is an error', () => {
  const result = validateApp(
    makeApp({ 'manifest.yaml': MANIFEST + 'branding:\n  primaryColor: "red"\n' }),
  )
  assert.equal(errorsMatching(result, /branding: primaryColor must be a #RGB/).length, 1)
})

test('branding: missing or non-svg/png logo is an error', () => {
  const result = validateApp(
    makeApp({ 'manifest.yaml': MANIFEST + 'branding:\n  logo: ./assets/logo.gif\n' }),
  )
  assert.equal(errorsMatching(result, /branding: logo must be an \.svg/).length, 1)
  assert.equal(errorsMatching(result, /branding: logo points to a missing file/).length, 1)
})

test('branding: SVG logos with scripting are errors', () => {
  const result = validateApp(
    makeApp({
      'manifest.yaml': MANIFEST + 'branding:\n  logo: ./assets/logo.svg\n',
      'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>',
    }),
  )
  assert.equal(errorsMatching(result, /branding: logo SVG contains scripting/).length, 1)
})

test('branding: oversized logos are errors', () => {
  const result = validateApp(
    makeApp({
      'manifest.yaml': MANIFEST + 'branding:\n  logo: ./assets/logo.svg\n',
      'assets/logo.svg': LOGO_SVG + '<!--' + 'x'.repeat(130 * 1024) + '-->',
    }),
  )
  assert.equal(errorsMatching(result, /branding: logo exceeds 128 KB/).length, 1)
})

test('SDK freshness: importing @veltrixsecops/app-sdk/ui with an old declared SDK version warns', () => {
  const result = validateApp(
    makeApp({
      'package.json': JSON.stringify({
        name: 'veltrix-app-fixture-app',
        version: '1.0.0',
        devDependencies: { '@veltrixsecops/app-sdk': '^2.0.0' },
      }),
      'client/index.tsx': "import { Button } from '@veltrixsecops/app-sdk/ui'\nexport default { id: 'fixture-app', pages: {} }\n",
    }),
  )
  assert.equal(warningsMatching(result, /app imports @veltrixsecops\/app-sdk\/ui but declares "\^2\.0\.0"/).length, 1)
})

test('SDK freshness: declaring ^2.1.0 or newer while importing @veltrixsecops/app-sdk/ui does not warn', () => {
  const result = validateApp(
    makeApp({
      'package.json': JSON.stringify({
        name: 'veltrix-app-fixture-app',
        version: '1.0.0',
        devDependencies: { '@veltrixsecops/app-sdk': '^2.1.0' },
      }),
      'client/index.tsx': "import { Button } from '@veltrixsecops/app-sdk/ui'\nexport default { id: 'fixture-app', pages: {} }\n",
    }),
  )
  assert.equal(warningsMatching(result, /app-sdk\/ui/).length, 0)
})

// --- Release notes (CHANGELOG.md) ---------------------------------------------

test('release notes: a missing CHANGELOG.md is a warning, not an error', () => {
  const result = validateApp(makeApp())
  assert.deepEqual(errorsMatching(result, /release notes:/), [])
  assert.equal(warningsMatching(result, /release notes: add a CHANGELOG\.md/).length, 1)
})

test('release notes: a CHANGELOG entry matching the manifest version passes clean', () => {
  const result = validateApp(
    makeApp({ 'CHANGELOG.md': '# Changelog\n\n## 1.0.0 — 2026-07-20\n\n- Initial release.\n' }),
  )
  assert.deepEqual(errorsMatching(result, /release notes:/), [])
  assert.deepEqual(warningsMatching(result, /release notes:/), [])
})

test('release notes: a CHANGELOG without an entry for the current version is an error', () => {
  const result = validateApp(
    makeApp({ 'CHANGELOG.md': '# Changelog\n\n## 0.9.0 — 2026-06-01\n\n- Old.\n' }),
  )
  assert.equal(errorsMatching(result, /CHANGELOG\.md has no entry for version 1\.0\.0/).length, 1)
})

test('release notes: a dateless CHANGELOG heading warns but does not error', () => {
  const result = validateApp(makeApp({ 'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- Notes.\n' }))
  assert.deepEqual(errorsMatching(result, /release notes:/), [])
  assert.equal(warningsMatching(result, /entry for 1\.0\.0 has no date/).length, 1)
})
