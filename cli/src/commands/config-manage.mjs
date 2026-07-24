// Comprehensive configuration-canvas management: draft (create), edit (update),
// validate, submit for approval, delete, and inspect approvals — the full
// authoring lifecycle short of deploy (see deploy.mjs). Every command is a thin,
// well-labelled wrapper over the platform's configuration-canvas + pipeline API.

import fs from 'node:fs'
import readline from 'node:readline'
import yaml from 'js-yaml'
import { getProfile } from '../lib/config.mjs'
import {
  createCanvas,
  updateCanvas,
  validateCanvas,
  submitForApproval,
  deleteCanvas,
  getApprovals,
  listEnvironments,
  listUsers,
  resolveEnvironmentId,
  resolveApproverIds,
  isUuid,
} from '../lib/deploy-api.mjs'
import { c } from '../lib/output.mjs'

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

/** Parse a YAML/JSON config spec. `partial` (for update) requires only what's present. */
export function loadConfigSpec(file, { partial = false } = {}) {
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
  if (!partial) {
    const missing = ['name', 'app', 'configType', 'sections'].filter((k) => spec[k] == null)
    if (missing.length) fail(`Spec is missing required field(s): ${missing.join(', ')}`)
    if (!Array.isArray(spec.sections) || spec.sections.length === 0) fail('Spec `sections` must be a non-empty array.')
  }
  return spec
}

function printValidation(v) {
  const errors = v.errors ?? []
  const warnings = v.warnings ?? []
  if (v.valid) console.log(`${c.green('✔ valid')}${warnings.length ? c.dim(` (${warnings.length} warning(s))`) : ''}`)
  else console.log(c.red(`✖ invalid — ${errors.length} error(s)`))
  for (const e of errors) console.log(`  ${c.red('error')} ${e.field ?? ''}: ${e.message}`)
  for (const w of warnings) console.log(`  ${c.yellow('warn')}  ${w.field ?? ''}: ${w.message}`)
}

/** veltrix config create <spec> — draft a configuration from a spec (no deploy). */
export async function configCreateCommand(specFile, options) {
  const profile = requireProfile(options)
  const spec = loadConfigSpec(specFile)
  const created = await createCanvas(profile, {
    name: spec.name,
    toolType: spec.app,
    entityType: spec.configType,
    sections: spec.sections,
    ...(spec.description != null ? { description: spec.description } : {}),
  })
  const canvas = created.data ?? created
  const id = canvas.id
  console.log(`✔ Draft created: ${c.bold(spec.name)}  ${c.dim(id)}  (status ${canvas.status ?? 'DRAFT'})`)
  if (options.validate) {
    const res = await validateCanvas(profile, id)
    printValidation(res.data ?? res)
  }
  console.log(c.dim(`  Edit:   veltrix config update ${id} --spec <file>`))
  console.log(c.dim(`  Submit: veltrix config submit ${id} --approvers <email> --env <name>`))
  console.log(c.dim(`  Deploy: veltrix deploy --canvas ${id} --env <name>  (after approval)`))
}

/** veltrix config update <id> --spec <file> — edit a draft's name/description/sections. */
export async function configUpdateCommand(id, options) {
  const profile = requireProfile(options)
  if (!options.spec) fail('Provide --spec <file> with the fields to update (name, description, and/or sections).')
  const spec = loadConfigSpec(options.spec, { partial: true })
  const body = {}
  if (spec.name != null) body.name = spec.name
  if (spec.description != null) body.description = spec.description
  if (spec.sections != null) body.sections = spec.sections
  if (Object.keys(body).length === 0) fail('Nothing to update — spec had no name, description, or sections.')
  const res = await updateCanvas(profile, id, body)
  const canvas = res.data ?? res
  console.log(`✔ Updated ${c.dim(id)}  (v${canvas.version ?? '?'}, status ${canvas.status ?? '?'})`)
}

/** veltrix config validate <id> — run the config type's validate handler. */
export async function configValidateCommand(id, options) {
  const profile = requireProfile(options)
  const res = await validateCanvas(profile, id)
  const v = res.data ?? res
  printValidation(v)
  if (!v.valid) process.exit(2)
}

/** veltrix config submit <id> — submit a draft for approval (approval is always required). */
export async function configSubmitCommand(id, options) {
  const profile = requireProfile(options)
  if (!options.approvers) fail('Provide --approvers <email,email> — deployments always require approval.')
  const refs = String(options.approvers).split(',').map((s) => s.trim()).filter(Boolean)
  const users = refs.every(isUuid) ? [] : await listUsers(profile)
  const approverIds = resolveApproverIds(refs, users)
  const body = { approverIds }
  if (options.env) {
    const envs = isUuid(options.env) ? [] : await listEnvironments(profile)
    body.environmentTagIds = [resolveEnvironmentId(options.env, envs)]
  }
  if (options.comment) body.comment = options.comment
  await submitForApproval(profile, id, body)
  console.log(`✔ Submitted ${c.dim(id)} for approval — ${approverIds.length} approver(s).`)
}

/** veltrix config delete <id> — delete a configuration (confirms unless --yes). */
export async function configDeleteCommand(id, options) {
  const profile = requireProfile(options)
  if (!options.yes) {
    const ok = await confirm(`Delete configuration ${id}? [y/N] `)
    if (!ok) {
      console.log('Aborted.')
      return
    }
  }
  await deleteCanvas(profile, id)
  console.log(`✔ Deleted ${c.dim(id)}.`)
}

/** veltrix config approvals <id> — show the canvas's approval requests + status. */
export async function configApprovalsCommand(id, options) {
  const profile = requireProfile(options)
  const res = await getApprovals(profile, id)
  const approvals = res.data ?? res ?? []
  if (!Array.isArray(approvals) || approvals.length === 0) {
    console.log('No approval requests for this configuration.')
    return
  }
  for (const a of approvals) {
    const who = a.approver?.email ?? a.approverId ?? a.approver?.name ?? '?'
    console.log(`  ${a.status ?? '?'}  ${who}${a.comment ? c.dim(`  — ${a.comment}`) : ''}`)
  }
}
