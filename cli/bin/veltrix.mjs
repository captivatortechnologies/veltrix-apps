#!/usr/bin/env node
// ============================================================================
// Veltrix CLI
//
// veltrix login              Authenticate against your Veltrix tenant
// veltrix whoami             Show the authenticated identity
// veltrix logout             Remove stored credentials
// veltrix validate [dir]     Validate an app against the platform contract
// veltrix package [dir]      Build a release-identical ZIP (compiled JS)
// veltrix sandbox …          Manage developer sandboxes in your tenant
// veltrix dev [dir]          Live-sync an app directory into a sandbox
// ============================================================================

import { createRequire } from 'node:module'
import { Command } from 'commander'
import { initCommand } from '../src/commands/init.mjs'
import { loginCommand } from '../src/commands/login.mjs'
import { logoutCommand } from '../src/commands/logout.mjs'
import { whoamiCommand } from '../src/commands/whoami.mjs'
import { validateCommand } from '../src/commands/validate.mjs'
import { packageCommand } from '../src/commands/package.mjs'
import {
  sandboxCreateCommand,
  sandboxListCommand,
  sandboxDeleteCommand,
  sandboxRunCommand,
} from '../src/commands/sandbox.mjs'
import { devCommand } from '../src/commands/dev.mjs'
import { deployCommand, deployStatusCommand } from '../src/commands/deploy.mjs'
import { appsCommand, envCommand, configListCommand, configGetCommand } from '../src/commands/inspect.mjs'
import {
  configCreateCommand,
  configUpdateCommand,
  configValidateCommand,
  configSubmitCommand,
  configDeleteCommand,
  configApprovalsCommand,
} from '../src/commands/config-manage.mjs'
import { driftListCommand, driftCheckCommand, driftScheduleCommand } from '../src/commands/drift.mjs'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const program = new Command()

program
  .name('veltrix')
  .description('CLI for building and shipping Veltrix Security-as-Code apps')
  .version(version)

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

const sandbox = program
  .command('sandbox')
  .description('Manage developer sandboxes in your tenant (requires SANDBOX_ENABLED)')

sandbox
  .command('create')
  .description('Create a sandbox for live development of an app')
  .argument('<name>', 'Sandbox name (lowercase, hyphens, unique per tenant)')
  .requiredOption('--app <app-id>', 'App id under development (matches manifest.id)')
  .option('--profile <name>', 'Profile name', 'default')
  .action(sandboxCreateCommand)

sandbox
  .command('list')
  .description('List your tenant sandboxes')
  .option('--profile <name>', 'Profile name', 'default')
  .action(sandboxListCommand)

sandbox
  .command('delete')
  .description('Delete a sandbox and its synced files')
  .argument('<name>', 'Sandbox name')
  .option('--yes', 'Skip the confirmation prompt')
  .option('--profile <name>', 'Profile name', 'default')
  .action(sandboxDeleteCommand)

sandbox
  .command('run')
  .description('Invoke a pipeline handler inside a synced sandbox')
  .argument('<name>', 'Sandbox name')
  .argument('<config-type-id>', 'Configuration type id (e.g. indexes)')
  .argument('<handler>', 'Handler name (validate, deploy, rollback, healthCheck, driftDetect, getStatus)')
  .option('--profile <name>', 'Profile name', 'default')
  .action(sandboxRunCommand)

program
  .command('dev')
  .description('Watch an app directory and live-sync it into a tenant sandbox (two-way)')
  .argument('[dir]', 'App directory', '.')
  .requiredOption('--sandbox <name>', 'Sandbox to sync into (see `veltrix sandbox create`)')
  .option('--create', 'Create the sandbox first if it does not exist')
  .option('--run <spec>', 'Invoke <configTypeId>:<handler> after each successful sync')
  .option('--logs', 'Stream live sandbox logs when the platform supports it')
  .option('--no-pull', 'Disable reverse sync — do not apply portal edits to local files (one-way)')
  .option('--force-pull', 'On conflict, overwrite local files with the sandbox version')
  .option('--profile <name>', 'Profile name', 'default')
  .action(devCommand)

const deploy = program
  .command('deploy')
  .description('Create + deploy a Configuration Canvas to a tool via the pipeline (approval always required)')
  .argument('[spec]', 'Deploy spec file (YAML/JSON): name, app, configType, environment, approvers, sections')
  .option('--canvas <id>', 'Deploy an already-created, APPROVED canvas (skips create/validate/submit)')
  .option('--env <name|id>', 'Environment (name or Tag id) — required with --canvas; overrides the spec otherwise')
  .option('--wait', 'Wait for approval, then deploy and poll the deployment to completion')
  .option('--strategy <strategy>', 'Deploy strategy: DIRECT | CANARY | BLUE_GREEN | ROLLING')
  .option('--timeout <seconds>', 'Poll timeout for --wait (default 600)', '600')
  .option('--yes', 'Skip the pre-deploy confirmation prompt')
  .option('--profile <name>', 'Profile name', 'default')
  .action(deployCommand)

deploy
  .command('status')
  .description('Show a deployment’s current status and recent logs')
  .argument('<deploymentId>', 'Deployment id (from `veltrix deploy`)')
  .option('--profile <name>', 'Profile name', 'default')
  .action(deployStatusCommand)

program
  .command('apps')
  .description('List the tenant’s installed + enabled apps (valid deploy `app` values)')
  .option('--profile <name>', 'Profile name', 'default')
  .action(appsCommand)

program
  .command('env')
  .description('List environments (valid deploy `environment` names + Tag ids)')
  .option('--profile <name>', 'Profile name', 'default')
  .action(envCommand)

const config = program.command('config').description('Author, inspect, and manage configuration canvases')

config
  .command('list')
  .description('List configuration canvases and their status')
  .option('--profile <name>', 'Profile name', 'default')
  .action(configListCommand)

config
  .command('get')
  .description('Show one configuration canvas with its sections/fields')
  .argument('<id>', 'Canvas id')
  .option('--profile <name>', 'Profile name', 'default')
  .action(configGetCommand)

config
  .command('create')
  .description('Draft a configuration from a spec (name, app, configType, sections) — no deploy')
  .argument('<spec>', 'Spec file (YAML/JSON)')
  .option('--validate', 'Validate the draft after creating it')
  .option('--profile <name>', 'Profile name', 'default')
  .action(configCreateCommand)

config
  .command('update')
  .description('Edit a draft configuration (name, description, and/or sections)')
  .argument('<id>', 'Canvas id')
  .requiredOption('--spec <file>', 'Spec file (YAML/JSON) with the fields to update')
  .option('--profile <name>', 'Profile name', 'default')
  .action(configUpdateCommand)

config
  .command('validate')
  .description('Validate a configuration (runs the config type\'s validate handler)')
  .argument('<id>', 'Canvas id')
  .option('--profile <name>', 'Profile name', 'default')
  .action(configValidateCommand)

config
  .command('submit')
  .description('Submit a draft for approval (approval is always required before deploy)')
  .argument('<id>', 'Canvas id')
  .requiredOption('--approvers <emails>', 'Comma-separated approver emails or user ids')
  .option('--env <name|id>', 'Environment the approval targets')
  .option('--comment <text>', 'Optional note for the approvers')
  .option('--profile <name>', 'Profile name', 'default')
  .action(configSubmitCommand)

config
  .command('approvals')
  .description('Show a configuration\'s approval requests and their status')
  .argument('<id>', 'Canvas id')
  .option('--profile <name>', 'Profile name', 'default')
  .action(configApprovalsCommand)

config
  .command('delete')
  .description('Delete a configuration')
  .argument('<id>', 'Canvas id')
  .option('--yes', 'Skip the confirmation prompt')
  .option('--profile <name>', 'Profile name', 'default')
  .action(configDeleteCommand)

const drift = program.command('drift').description('Inspect and schedule configuration drift')

drift
  .command('list')
  .description('List drift records + the async check state for one configuration')
  .argument('<canvasId>', 'Canvas id')
  .option('--profile <name>', 'Profile name', 'default')
  .action(driftListCommand)

drift
  .command('check')
  .description('Run an on-demand drift check for one configuration (polls to completion)')
  .argument('<canvasId>', 'Canvas id')
  .option('--profile <name>', 'Profile name', 'default')
  .action(driftCheckCommand)

drift
  .command('schedule')
  .description('Show or change the scheduled-check frequency (tenant default + per-app overrides)')
  .option('--set <frequency>', 'Set the frequency: off | hourly | daily | weekly')
  .option('--app <appId>', 'Scope to a per-app override (else the tenant default)')
  .option('--clear', 'Clear a per-app override (requires --app)')
  .option('--profile <name>', 'Profile name', 'default')
  .action(driftScheduleCommand)

program.parseAsync().catch((err) => {
  console.error(`✖ ${err.message}`)
  process.exit(1)
})
