// Shared helpers for the JumpCloud Commands config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// Commands are applied over the JumpCloud API v1 (/commands) — VERIFIED against
// JumpCloud's published API v1 OpenAPI spec
// (github.com/TheJumpCloud/jumpcloud-docs-public, docs/api/1.0/index.yaml).
//
// Managed fields: name, description, command, commandType, shell, user, sudo,
// launchType, schedule, scheduleRepeatType, trigger, timeout, commandRunners.
// Deliberately NOT managed (see README "Coverage"): `files` / `filesS3` (binary
// file attachments — not pure JSON/text config) and `systems` (JumpCloud's own
// API docs mark this field "Not used. Use /api/v2/commands/{id}/associations to
// bind commands to systems" — association management, out of this type's scope,
// same reasoning as every other association-only surface in this app).

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const COMMAND_TYPES = ['linux', 'windows', 'mac'] as const
export type CommandType = (typeof COMMAND_TYPES)[number]

/** One JumpCloud Command as returned by GET /commands and GET /commands/{id}. */
export interface JumpCloudCommand {
  _id?: string
  name?: string
  description?: string
  command?: string
  commandType?: string
  shell?: string
  user?: string
  sudo?: boolean
  launchType?: string
  schedule?: string
  scheduleRepeatType?: string
  trigger?: string
  timeout?: string | number
  commandRunners?: string[]
  [key: string]: unknown
}

/** The desired state for one Command, extracted from a canvas item. */
export interface CommandSpec {
  /** Stable canvas item id — survives renames; used for rename-safe identity. */
  itemId?: string
  /** Command name — the logical identity live commands are matched on. */
  name: string
  description: string
  command: string
  commandType: string
  shell: string
  user: string
  sudo: boolean
  launchType: string
  schedule: string
  scheduleRepeatType: string
  trigger: string
  timeout: string
  commandRunners: string[]
}

/** Coerce a checkbox-ish value to a boolean (defaults false). */
export function normalizeSudo(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

/** Split a commandRunners value (a tags array or a newline/comma string) into trimmed entries. */
export function toIdList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const s = String(entry ?? '').trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** Each canvas item describes one JumpCloud Command. */
export function extractCommandSpecs(canvas: CanvasSnapshot): CommandSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(fields.name ?? '').trim(),
      description: String(fields.description ?? '').trim(),
      command: String(fields.command ?? '').trim(),
      commandType: String(fields.commandType ?? 'linux').trim() || 'linux',
      shell: String(fields.shell ?? '').trim(),
      user: String(fields.user ?? '').trim(),
      sudo: normalizeSudo(fields.sudo),
      launchType: String(fields.launchType ?? '').trim(),
      schedule: String(fields.schedule ?? '').trim(),
      scheduleRepeatType: String(fields.scheduleRepeatType ?? '').trim(),
      trigger: String(fields.trigger ?? '').trim(),
      timeout: String(fields.timeout ?? '').trim(),
      commandRunners: toIdList(fields.commandRunners),
    }
  })
}

/** Find a live Command by name (case-insensitive — the stable identity). */
export function findCommandByName(commands: JumpCloudCommand[], name: string): JumpCloudCommand | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return commands.find((c) => String(c.name ?? '').trim().toLowerCase() === target) ?? null
}

/** Build the JumpCloud Command body for POST/PUT /commands. Optional string fields are always sent (empty clears them) so a PUT converges the live command and drift agrees about the target state. */
export function buildCommandBody(spec: CommandSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    command: spec.command,
    commandType: spec.commandType,
    shell: spec.shell,
    user: spec.user,
    sudo: spec.sudo,
    launchType: spec.launchType,
    schedule: spec.schedule,
    scheduleRepeatType: spec.scheduleRepeatType,
    trigger: spec.trigger,
    timeout: spec.timeout,
    commandRunners: spec.commandRunners,
  }
}

/** The subset of a live command's fields this config type manages — captured for rollback. */
export function priorFieldsOf(command: JumpCloudCommand): Record<string, unknown> {
  return {
    name: String(command.name ?? ''),
    description: String(command.description ?? ''),
    command: String(command.command ?? ''),
    commandType: String(command.commandType ?? 'linux'),
    shell: String(command.shell ?? ''),
    user: String(command.user ?? ''),
    sudo: Boolean(command.sudo),
    launchType: String(command.launchType ?? ''),
    schedule: String(command.schedule ?? ''),
    scheduleRepeatType: String(command.scheduleRepeatType ?? ''),
    trigger: String(command.trigger ?? ''),
    timeout: String(command.timeout ?? ''),
    commandRunners: Array.isArray(command.commandRunners) ? command.commandRunners : [],
  }
}
