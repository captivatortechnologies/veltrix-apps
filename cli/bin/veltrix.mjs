#!/usr/bin/env node
// ============================================================================
// Veltrix CLI
//
// veltrix login              Authenticate against your Veltrix tenant
// veltrix whoami             Show the authenticated identity
// veltrix logout             Remove stored credentials
// veltrix validate [dir]     Validate an app against the platform contract
// veltrix package [dir]      Build a release-identical ZIP (compiled JS)
//
// Coming next: veltrix sandbox create|list|delete, veltrix dev (near-realtime
// sync of your local app into a tenant sandbox).
// ============================================================================

import { Command } from 'commander'
import { initCommand } from '../src/commands/init.mjs'
import { loginCommand } from '../src/commands/login.mjs'
import { logoutCommand } from '../src/commands/logout.mjs'
import { whoamiCommand } from '../src/commands/whoami.mjs'
import { validateCommand } from '../src/commands/validate.mjs'
import { packageCommand } from '../src/commands/package.mjs'

const program = new Command()

program
  .name('veltrix')
  .description('CLI for building and shipping Veltrix Security-as-Code apps')
  .version('0.1.0')

program
  .command('init')
  .description('Scaffold a new app with the canonical Veltrix layout')
  .argument('<app-id>', 'App id (lowercase, hyphens, e.g. crowdstrike-edr)')
  .option('--dir <dir>', 'Parent directory to create the app in', '.')
  .action(initCommand)

program
  .command('login')
  .description('Authenticate with an API key from Settings → Keys & Tokens')
  .option('--url <url>', 'Platform URL', 'https://app.veltrixsecops.com')
  .option('--api-key <key>', 'API key (omit to be prompted; VELTRIX_API_KEY env var also works)')
  .option('--profile <name>', 'Profile name', 'default')
  .action(loginCommand)

program
  .command('whoami')
  .description('Show the authenticated tenant and key scopes')
  .option('--profile <name>', 'Profile name', 'default')
  .action(whoamiCommand)

program
  .command('logout')
  .description('Remove stored credentials')
  .option('--profile <name>', 'Profile name', 'default')
  .action(logoutCommand)

program
  .command('validate')
  .description('Validate an app directory against the platform contract')
  .argument('[dir]', 'App directory', '.')
  .action(validateCommand)

program
  .command('package')
  .description('Build a release-identical ZIP (server-side TS compiled to JS)')
  .argument('[dir]', 'App directory', '.')
  .option('--out <dir>', 'Output directory', 'dist')
  .action(packageCommand)

program.parseAsync().catch((err) => {
  console.error(`✖ ${err.message}`)
  process.exit(1)
})
