// ============================================================================
// `veltrix deploy` — create + deploy a Configuration Canvas to a tool through
// the platform pipeline, authenticated with your API key.
//
//   veltrix deploy <spec.yaml>            # create, validate, submit for approval
//   veltrix deploy <spec.yaml> --wait     # ...then wait for approval + deploy
//   veltrix deploy --canvas <id> --env e  # deploy an already-APPROVED canvas
//
// Approval is ALWAYS required: a new canvas is DRAFT, submit-for-approval moves
// it to pending, and the pipeline refuses to deploy anything not APPROVED. The
// CLI never self-approves — a human approves in the portal (or via their own
// session), then the deploy proceeds.
// ============================================================================

import fs from 'node:fs'
import readline from 'node:readline'
import yaml from 'js-yaml'
import { getProfile } from '../lib/config.mjs'
import { ApiError } from '../lib/api.mjs'
import { c } from '../lib/output.mjs'
import {
  listEnvironments,
  listUsers,
  createCanvas,
  getCanvas,
  validateCanvas,
  submitForApproval,
  deployCanvas,
  getDeployment,
  getCanvasDeployments,
  rollbackDeployment,
  resolveEnvironmentId,
  resolveApproverIds,
  isUuid,
  DEPLOYABLE_STATUSES,
  TERMINAL_DEPLOYMENT_STATUSES,
} from '../lib/deploy-api.mjs'

function requireProfile(options) {
  const profile = getProfile(options.profile)
  if (!profile) {
    console.error('✖ Not logged in. Run `veltrix login` first.')
    process.exit(1)
  }
  return profile
}

function fail(message, hint) {
  console.error(`✖ ${message}`)
  if (hint) console.error(c.dim(`  ${hint}`))
  process.exit(1)
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(/^y(es)?$/i.test(answer.trim()))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Read + parse a YAML/JSON deploy spec (JSON is valid YAML, so one parser covers both). */
function loadSpec(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    fail(`Could not read spec file: ${file}`)
  }
  let spec
  try {
    spec = yaml.load(raw)
  } catch (e) {
    fail(`Invalid YAML/JSON in ${file}: ${e.message}`)
  }
  if (!spec || typeof spec !== 'object') fail(`Spec file ${file} did not parse to an object.`)
  const missing = ['name', 'app', 'configType', 'environment', 'sections'].filter((k) => spec[k] == null)
  if (missing.length) fail(`Spec is missing required field(s): ${missing.join(', ')}`)
  if (!Array.isArray(spec.sections) || spec.sections.length === 0) fail('Spec `sections` must be a non-empty array.')
  const approvers = spec.approvers ?? []
  if (!Array.isArray(approvers) || approvers.length === 0) {
    fail('Spec `approvers` must list at least one approver (email or user id).', 'API deploys always require approval.')
  }
  return { ...spec, approvers }
}

/** Poll a canvas until it reaches a deployable status, is rejected, or times out. */
async function waitForApproval(profile, canvasId, timeoutMs) {
  const started = Date.now()
  process.stdout.write(c.dim('Waiting for approval'))
  while (Date.now() - started < timeoutMs) {
    const canvas = await getCanvas(profile, canvasId)
    const status = canvas?.status
    if (DEPLOYABLE_STATUSES.has(status)) {
      process.stdout.write('\n')
      return status
    }
    if (status === 'REJECTED') {
      process.stdout.write('\n')
      fail('Canvas was rejected — not deploying.')
    }
    process.stdout.write(c.dim('.'))
    await sleep(5000)
  }
  process.stdout.write('\n')
  fail(`Timed out waiting for approval after ${Math.round(timeoutMs / 1000)}s.`, `Approve it in the portal, then: veltrix deploy --canvas ${canvasId} --env <env>`)
}

/** Poll a deployment until terminal, printing the final status + any logs. */
async function waitForDeployment(profile, deploymentId, timeoutMs) {
  const started = Date.now()
  process.stdout.write(c.dim('Deploying'))
  while (Date.now() - started < timeoutMs) {
    const dep = await getDeployment(profile, deploymentId)
    const status = dep?.status
    if (TERMINAL_DEPLOYMENT_STATUSES.has(status)) {
      process.stdout.write('\n')
      const ok = status === 'DEPLOYED'
      console.log(`${ok ? c.green('✔') : c.red('✖')} Deployment ${status.toLowerCase()} (${deploymentId})`)
      const logs = Array.isArray(dep.logs) ? dep.logs : []
      for (const line of logs.slice(-20)) {
        const text = typeof line === 'string' ? line : line?.message ?? JSON.stringify(line)
        console.log(c.dim(`  ${text}`))
      }
      if (!ok) process.exitCode = 1
      return
    }
    process.stdout.write(c.dim('.'))
    await sleep(5000)
  }
  process.stdout.write('\n')
  console.log(c.dim(`Still deploying — check status: veltrix deploy status ${deploymentId}`))
}

async function runDeploy(profile, canvasId, environmentId, options) {
  if (!options.yes && process.stdin.isTTY) {
    const ok = await confirm(`Deploy canvas ${canvasId} to environment ${environmentId}? This pushes config to the live tool. [y/N] `)
    if (!ok) {
      console.log('Aborted.')
      return
    }
  }
  const body = { environmentId }
  if (options.strategy) body.strategy = options.strategy
  const res = await deployCanvas(profile, canvasId, body)
  const deploymentId = res?.deploymentId
  console.log(`${c.green('✔')} Deploy queued — deployment ${c.bold(deploymentId)}`)
  const timeoutMs = (Number(options.timeout) || 600) * 1000
  await waitForDeployment(profile, deploymentId, timeoutMs)
}

export async function deployCommand(file, options) {
  const profile = requireProfile(options)
  const timeoutMs = (Number(options.timeout) || 600) * 1000

  try {
    // --- Deploy an already-created (approved) canvas --------------------------
    if (options.canvas) {
      if (!options.env) fail('--canvas requires --env <name|id>.')
      const environments = isUuid(options.env) ? [] : await listEnvironments(profile)
      const environmentId = resolveEnvironmentId(options.env, environments)
      if (!environmentId) fail(`Environment "${options.env}" not found.`, 'Run with a valid env name or Tag id.')
      const canvas = await getCanvas(profile, options.canvas)
      if (!DEPLOYABLE_STATUSES.has(canvas?.status)) {
        fail(`Canvas ${options.canvas} is ${canvas?.status ?? 'unknown'}, not deployable.`, 'It must be APPROVED first (approval is always required).')
      }
      await runDeploy(profile, options.canvas, environmentId, options)
      return
    }

    // --- Create → validate → submit (→ wait → deploy) -------------------------
    if (!file) fail('Provide a spec file (veltrix deploy <spec.yaml>) or --canvas <id>.')
    const spec = loadSpec(file)

    // Resolve environment (name → Tag id) and approvers (email → user id). Only
    // hit the lookup routes when a reference is a name, not already a UUID — so a
    // spec that uses ids works even where those read routes aren't API-key-enabled.
    const environments = isUuid(spec.environment) ? [] : await listEnvironments(profile)
    const environmentId = resolveEnvironmentId(spec.environment, environments)
    if (!environmentId) {
      fail(`Environment "${spec.environment}" not found.`, `Available: ${environments.map((e) => e.name).join(', ') || '(pass the Tag id directly)'}`)
    }
    const needUserLookup = spec.approvers.some((a) => !isUuid(a))
    const users = needUserLookup ? await listUsers(profile) : []
    const { ids: approverIds, unresolved } = resolveApproverIds(spec.approvers, users)
    if (unresolved.length) fail(`Could not resolve approver(s): ${unresolved.join(', ')}`, 'Use a tenant user email or user id.')

    console.log(c.dim(`Creating canvas "${spec.name}" (${spec.app}/${spec.configType})…`))
    const canvas = await createCanvas(profile, {
      name: spec.name,
      toolType: spec.app,
      entityType: spec.configType,
      sections: spec.sections,
      tagIds: [environmentId],
    })
    const canvasId = canvas?.id
    if (!canvasId) fail('Create did not return a canvas id.')
    console.log(`${c.green('✔')} Canvas created — ${c.bold(canvasId)}`)

    // Validate.
    const validation = await validateCanvas(profile, canvasId)
    const errors = Array.isArray(validation?.errors) ? validation.errors : []
    if (validation?.valid === false || errors.length) {
      console.error(`${c.red('✖')} Validation failed:`)
      for (const err of errors.slice(0, 20)) {
        console.error(c.dim(`  ${err.field ? err.field + ': ' : ''}${err.message ?? JSON.stringify(err)}`))
      }
      process.exit(1)
    }
    console.log(`${c.green('✔')} Validated`)

    // Submit for approval.
    const submitRes = await submitForApproval(profile, canvasId, { approverIds, environmentTagIds: [environmentId] })
    const statusAfterSubmit = submitRes?.status ?? (await getCanvas(profile, canvasId))?.status
    console.log(`${c.green('✔')} Submitted for approval (${approverIds.length} approver(s))`)

    // Already approved (env policy auto-approves) → deploy path is open.
    if (DEPLOYABLE_STATUSES.has(statusAfterSubmit)) {
      console.log(c.dim('Canvas is already approved by the environment policy.'))
      await runDeploy(profile, canvasId, environmentId, options)
      return
    }

    if (!options.wait) {
      console.log('')
      console.log(`⏳ Awaiting approval. Once approved in the portal, deploy with:`)
      console.log(`   ${c.cyan(`veltrix deploy --canvas ${canvasId} --env ${spec.environment}`)}`)
      return
    }

    await waitForApproval(profile, canvasId, timeoutMs)
    await runDeploy(profile, canvasId, environmentId, options)
  } catch (error) {
    if (error instanceof ApiError) fail(error.message, error.status ? `HTTP ${error.status}` : undefined)
    fail(error.message)
  }
}

/** `veltrix deploy status <deploymentId>` — print a deployment's current status + logs. */
export async function deployStatusCommand(deploymentId, options) {
  const profile = requireProfile(options)
  try {
    const dep = await getDeployment(profile, deploymentId)
    console.log(`Deployment ${c.bold(deploymentId)}: ${c.bold(dep?.status ?? 'unknown')}`)
    const logs = Array.isArray(dep?.logs) ? dep.logs : []
    for (const line of logs.slice(-40)) {
      const text = typeof line === 'string' ? line : line?.message ?? JSON.stringify(line)
      console.log(c.dim(`  ${text}`))
    }
  } catch (error) {
    fail(error.message)
  }
}

/** `veltrix deploy rollback <canvasId>` — roll a config back to its previous deployed state. */
export async function deployRollbackCommand(canvasId, options) {
  const profile = requireProfile(options)
  if (!options.yes && process.stdin.isTTY) {
    const ok = await confirm(`Roll back configuration ${canvasId} to its previous deployed config? [y/N] `)
    if (!ok) {
      console.log('Aborted.')
      return
    }
  }
  try {
    const deployments = await getCanvasDeployments(profile, canvasId)
    const target = deployments.find((d) => d.status === 'SUCCEEDED')
    if (!target) fail('No successful deployment to roll back for this configuration.')
    const res = await rollbackDeployment(profile, target.id, 'Rolled back via the Veltrix CLI')
    const rollbackId = res?.deploymentId ?? res?.data?.deploymentId ?? res?.id
    console.log(c.dim(`Rolling back deployment ${target.id}…`))
    if (!rollbackId) {
      console.log(c.green('✔ Rollback requested.'))
      return
    }
    const timeoutMs = (Number(options.timeout) || 300) * 1000
    const started = Date.now()
    process.stdout.write(c.dim('Rolling back'))
    while (Date.now() - started < timeoutMs) {
      const dep = await getDeployment(profile, rollbackId)
      const status = dep?.status
      if (TERMINAL_DEPLOYMENT_STATUSES.has(status)) {
        process.stdout.write('\n')
        const ok = status === 'ROLLED_BACK' || status === 'DEPLOYED'
        console.log(`${ok ? c.green('✔') : c.red('✖')} Rollback ${String(status).toLowerCase()} (${rollbackId})`)
        if (!ok) process.exitCode = 1
        return
      }
      process.stdout.write(c.dim('.'))
      await sleep(5000)
    }
    process.stdout.write('\n')
    console.log(c.dim(`Still rolling back — check: veltrix deploy status ${rollbackId}`))
  } catch (error) {
    fail(error.message)
  }
}
