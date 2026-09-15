// ============================================================================
// Migration rules, kept in step with the platform's migration-runner.
//
// These exist so a contributor finds out locally instead of at install time.
// The platform tightened its guard after `SET LOCAL ROLE NONE` was found to
// defeat app isolation outright; until this validator matched, a migration
// containing it passed `veltrix validate` cleanly and was then refused by the
// platform. A validator that disagrees with the platform is worse than none,
// because it is believed.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateApp } from '../src/lib/validator.mjs'

const HANDLER = 'export default async function handler() {\n  return null\n}\n'

/**
 * A minimal valid app that declares schema isolation and a migrations folder.
 * Schema isolation is what the platform defaults to when a manifest declares
 * no `isolation`, so this is the shape real catalog apps run under.
 */
const MANIFEST = [
  'id: fixture-app',
  'name: Fixture App',
  'version: 1.0.0',
  'vendor: Test',
  'description: Fixture app for migration validator tests',
  'category: CUSTOM',
  'platform:',
  '  minVersion: "1.0.0"',
  'database:',
  '  migrations: migrations',
  '  tablePrefix: fixture_',
  '  isolation: schema',
  'permissions:',
  '  platform: []',
  '  app:',
  '    - resource: configs',
  '      actions: [read]',
  '      description: test',
  'pipeline:',
  '  configurationTypes:',
  '    - id: configs',
  '      name: Configs',
  '      canvasTemplate: config-types/configs/canvas.yaml',
  '      defaultConfig: config-types/configs/defaults.yaml',
  '      handlers:',
  '        validate: config-types/configs/validate',
  '        deploy: config-types/configs/deploy',
  '        rollback: config-types/configs/rollback',
  '        healthCheck: config-types/configs/healthCheck',
  '        getStatus: config-types/configs/getStatus',
  '      targets:',
  '        componentTypes: [test-component]',
  '        requiresCredential: false',
  '        requiresConnectivity: false',
  'server:',
  '  entry: server/index',
  '  routes:',
  '    prefix: /api/apps/fixture-app',
  '',
].join('\n')

const CANVAS = [
  'id: fixture-configs',
  'name: Configs',
  'toolType: fixture-app',
  'entityType: configs',
  'sections:',
  '  - name: General',
  '    fields:',
  '      - key: name',
  '        label: Name',
  '        fieldType: text',
  '        required: true',
  '',
].join('\n')

const DEFAULTS = ['General:', '  name: ""', ''].join('\n')

/** Write the fixture app with one migration file and return its path. */
function makeAppWithMigration(sql) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veltrix-migration-test-'))
  const appDir = path.join(root, 'fixture-app')
  const files = {
    'manifest.yaml': MANIFEST,
    'package.json': JSON.stringify({
      name: 'veltrix-app-fixture-app',
      private: true,
      version: '1.0.0',
    }),
    'README.md': '# Fixture',
    'config-types/configs/canvas.yaml': CANVAS,
    'config-types/configs/defaults.yaml': DEFAULTS,
    'config-types/configs/validate.ts': HANDLER,
    'config-types/configs/deploy.ts': HANDLER,
    'config-types/configs/rollback.ts': HANDLER,
    'config-types/configs/healthCheck.ts': HANDLER,
    'config-types/configs/getStatus.ts': HANDLER,
    'server/index.ts': 'export default async function registerRoutes() {}\n',
    'migrations/001_init.sql': sql,
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(appDir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return appDir
}

const migrationErrors = (result) => result.errors.filter((e) => /migrations:/.test(e))
const matching = (result, re) => result.errors.filter((e) => re.test(e))

test('a tenant-partitioned table passes, so the rules are not simply rejecting everything', () => {
  const result = validateApp(
    makeAppWithMigration(
      'CREATE TABLE fixture_things (id uuid PRIMARY KEY, customer_id uuid NOT NULL, name text);\n',
    ),
  )
  assert.deepEqual(migrationErrors(result), [])
})

test('session-state statements are rejected', () => {
  const result = validateApp(makeAppWithMigration('SET LOCAL ROLE NONE;\n'))
  assert.equal(matching(result, /session or transaction state/).length, 1)
})

test('a leading comment cannot smuggle a session-state statement past', () => {
  // The naive `sql.split(';')` this validator used left comments attached to the
  // statement, so the start-anchored check never matched and this passed. The
  // platform's splitter drops comments, so the platform caught it and the two
  // disagreed.
  const result = validateApp(
    makeAppWithMigration('-- set up the app role\nSET LOCAL ROLE NONE;\n'),
  )
  assert.equal(matching(result, /session or transaction state/).length, 1)
})

test('a block comment cannot smuggle one past either', () => {
  const result = validateApp(makeAppWithMigration('/* setup */ RESET ROLE;\n'))
  assert.equal(matching(result, /session or transaction state/).length, 1)
})

test('set_config() is rejected as the function form of SET', () => {
  const result = validateApp(
    makeAppWithMigration("SELECT pg_catalog.set_config('role','postgres',false);\n"),
  )
  assert.ok(matching(result, /may not run/).length >= 1)
})

test('CREATE TABLE AS SELECT is rejected outright', () => {
  // It declares no column list, so it cannot carry the tenant column — and it is
  // the exact shape of the exploit that reopened this finding.
  const result = validateApp(
    makeAppWithMigration('CREATE TABLE fixture_loot AS SELECT * FROM "Credential";\n'),
  )
  assert.equal(matching(result, /AS SELECT/).length, 1)
})

test('a table without customer_id is rejected under schema isolation', () => {
  const result = validateApp(
    makeAppWithMigration('CREATE TABLE fixture_things (id uuid PRIMARY KEY, name text);\n'),
  )
  assert.equal(matching(result, /customer_id/).length, 1)
})

test('a semicolon inside a comment does not split the statement', () => {
  // The old naive split produced a bogus trailing "statement" from the prose
  // after the semicolon, which could be reported as a spurious error.
  const result = validateApp(
    makeAppWithMigration(
      '-- foreign key; enforced in application code\n' +
        'CREATE TABLE fixture_things (id uuid PRIMARY KEY, customer_id uuid NOT NULL);\n',
    ),
  )
  assert.deepEqual(migrationErrors(result), [])
})

test('a semicolon inside a string literal does not split the statement', () => {
  const result = validateApp(
    makeAppWithMigration(
      'CREATE TABLE fixture_things (id uuid PRIMARY KEY, customer_id uuid NOT NULL, ' +
        "note text DEFAULT 'a; b');\n",
    ),
  )
  assert.deepEqual(migrationErrors(result), [])
})
