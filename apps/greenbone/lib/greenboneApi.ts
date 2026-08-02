// =============================================================================
// Greenbone access seam — GMP (Greenbone Management Protocol).
//
// GMP is NOT REST. It is a human-readable, XML request/response protocol spoken
// over a raw socket. Historically gvmd listens for GMP over TLS on port 9390
// (newer Greenbone OS releases prefer an SSH-tunnelled unix socket and mark the
// plain TLS listener as deprecated — see the FLAGS below). This module isolates
// the whole transport (open a TLS socket, authenticate, send one XML command,
// read one XML response) plus a tiny hand-rolled XML builder/parser, so the wire
// format lives behind a clear, swappable seam and the pipeline handlers deal only
// in typed helpers.
//
// Session model: GMP is stateful *on the connection*. The first command MUST be
// <authenticate>; once it succeeds the SAME socket is authorised for every
// subsequent command. Opening a new socket requires authenticating again.
//
// Verified against the official protocol docs (cite):
//   - GMP 22.5 command reference — https://docs.greenbone.net/API/GMP/gmp-22.5.html
//   - python-gvm (TLSConnection default port 9390, Gmp(connection).authenticate)
//     https://greenbone.github.io/python-gvm/
//   Observed response shapes:
//     <authenticate_response status="200" status_text="OK"><role>User</role>
//       <timezone>UTC</timezone></authenticate_response>
//     <create_target_response status="201" status_text="OK, resource created"
//       id="e5adc10c-71d0-49fe-aacf-a442ee31d387"/>
//   Status data type pattern: 200|201|202|400|401|403|404|409|500|503.
//
// FLAGS — verify against a live gvmd (GMP is version-specific):
//   * TRANSPORT/FRAMING: GMP has no length prefix. The client reads until the
//     single top-level response element is closed. isCompleteGmpResponse() is a
//     minimal "root element closed" detector (not a full XML parser) and assumes
//     the response root name does not recur nested inside the response.
//   * TLS on 9390 is the classic remote transport but is deprecated in current
//     Greenbone OS in favour of SSH → unix socket. This seam speaks TLS:9390; a
//     unix-socket / SSH-tunnel transport can be added behind the same interface.
//   * TLS trust: gvmd commonly ships a self-signed cert, so rejectUnauthorized
//     defaults to false (same posture as the MISP/Security-Onion seams). Some
//     deployments additionally require a CLIENT certificate — not handled here.
//   * modify_target: gvmd rejects changing <hosts>/<port_list> while the target
//     is in use by a task (status 400) — surfaced as an error, not silently.
// =============================================================================

import { connect as tlsConnect } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import type { ComponentRef, ConnectivityRef } from '@veltrixsecops/app-sdk'

/** Classic gvmd GMP-over-TLS port. */
export const DEFAULT_GMP_PORT = 9390

/** A GMP resource UUID (8-4-4-4-12 hex) — every gvmd entity id is one. */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Well-known feed-provided port list UUIDs (stable across installs that load the
 * Greenbone feed). "All IANA assigned TCP" (5836 ports) is the sensible default.
 */
export const PORT_LIST_ALL_IANA_TCP = '33d0cd82-57c6-11e1-8ed1-406186ea4fc5'
export const PORT_LIST_ALL_IANA_TCP_UDP = '4a4717fe-57d2-11e1-9a26-406186ea4fc5'
export const PORT_LIST_ALL_TCP_NMAP_TOP_100_UDP = '730ef368-57e2-11e1-a90f-406186ea4fc5'
export const PORT_LIST_OPENVAS_DEFAULT = 'c7e03b6c-3bbe-11e1-a057-406186ea4fc5'

// -----------------------------------------------------------------------------
// XML escaping — minimal, correct for text content and attribute values.
// -----------------------------------------------------------------------------

export function escapeXmlText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function escapeXmlAttr(value: unknown): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function unescapeXml(value: string): string {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&') // last: so "&amp;lt;" survives as "&lt;"
}

// -----------------------------------------------------------------------------
// GMP command builders.
// -----------------------------------------------------------------------------

export function buildAuthenticateCommand(username: string, password: string): string {
  return (
    '<authenticate><credentials>' +
    `<username>${escapeXmlText(username)}</username>` +
    `<password>${escapeXmlText(password)}</password>` +
    '</credentials></authenticate>'
  )
}

/** Read version — cheap reachability probe (does not require auth). */
export function buildGetVersionCommand(): string {
  return '<get_version/>'
}

/**
 * List targets. Defaults to `rows=-1` so ALL targets are returned — matching by
 * name for upsert/drift is unreliable if gvmd truncates to its default page.
 */
export function buildGetTargetsCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_targets filter="${escapeXmlAttr(filter)}"/>`
}

export interface TargetInput {
  name: string
  hosts: string
  portListId?: string
  comment?: string
  excludeHosts?: string
}

export function buildCreateTargetCommand(t: TargetInput): string {
  const parts = [`<name>${escapeXmlText(t.name)}</name>`, `<hosts>${escapeXmlText(t.hosts)}</hosts>`]
  if (t.excludeHosts && String(t.excludeHosts).trim()) {
    parts.push(`<exclude_hosts>${escapeXmlText(t.excludeHosts)}</exclude_hosts>`)
  }
  if (t.portListId && String(t.portListId).trim()) {
    parts.push(`<port_list id="${escapeXmlAttr(t.portListId)}"/>`)
  }
  if (t.comment && String(t.comment).trim()) {
    parts.push(`<comment>${escapeXmlText(t.comment)}</comment>`)
  }
  return `<create_target>${parts.join('')}</create_target>`
}

/**
 * Modify an existing target. Only the provided fields are sent. NOTE: gvmd
 * rejects changing hosts/exclude_hosts/port_list while the target is used by a
 * task (status 400) — the caller surfaces that error.
 */
export function buildModifyTargetCommand(
  targetId: string,
  t: { name?: string; hosts?: string; comment?: string; excludeHosts?: string },
): string {
  const parts: string[] = []
  if (t.name !== undefined) parts.push(`<name>${escapeXmlText(t.name)}</name>`)
  if (t.hosts !== undefined) parts.push(`<hosts>${escapeXmlText(t.hosts)}</hosts>`)
  if (t.excludeHosts !== undefined) parts.push(`<exclude_hosts>${escapeXmlText(t.excludeHosts)}</exclude_hosts>`)
  if (t.comment !== undefined) parts.push(`<comment>${escapeXmlText(t.comment)}</comment>`)
  return `<modify_target target_id="${escapeXmlAttr(targetId)}">${parts.join('')}</modify_target>`
}

/** Delete a target. `ultimate` true removes it permanently (skips the trashcan). */
export function buildDeleteTargetCommand(targetId: string, ultimate = true): string {
  return `<delete_target target_id="${escapeXmlAttr(targetId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

// -----------------------------------------------------------------------------
// GMP response parsing.
// -----------------------------------------------------------------------------

export interface GmpStatus {
  status: string
  statusText: string
  ok: boolean
}

/** Return the root element name + the raw attribute substring, quote-aware. */
function openingTag(xml: string): { name: string; attrs: string } | null {
  const s = String(xml ?? '').replace(/^﻿/, '').replace(/^\s+/, '')
  const m = /^<([A-Za-z_][\w.:-]*)/.exec(s)
  if (!m) return null
  let i = m[0].length
  let quote: string | null = null
  for (; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '>') break
  }
  if (i >= s.length) return null // opening tag not terminated yet
  const attrs = s.slice(m[0].length, i).replace(/\/\s*$/, '')
  return { name: m[1], attrs }
}

function attrsFrom(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrString))) {
    attrs[m[1]] = unescapeXml(m[2] ?? m[3] ?? '')
  }
  return attrs
}

/** Attributes on the top-level response element. */
export function parseRootAttributes(xml: string): Record<string, string> {
  const open = openingTag(xml)
  return open ? attrsFrom(open.attrs) : {}
}

/** The GMP status/status_text of a response. `ok` = any 2xx status. */
export function parseGmpStatus(xml: string): GmpStatus {
  const a = parseRootAttributes(xml)
  const status = a.status ?? ''
  return { status, statusText: a.status_text ?? '', ok: /^2/.test(status) }
}

/** The `id` attribute a create_* response carries for the new resource. */
export function parseCreatedId(xml: string): string | null {
  return parseRootAttributes(xml).id ?? null
}

/** Content of the first `<name>…</name>` style child of a fragment. */
function firstChildText(fragment: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(fragment)
  return m ? unescapeXml(m[1]) : null
}

export interface GmpTarget {
  id: string
  name: string
  hosts: string
  excludeHosts: string
  comment: string
  portListId: string | null
}

/** Parse `<target id="…">…</target>` elements out of a get_targets_response. */
export function parseTargets(xml: string): GmpTarget[] {
  const out: GmpTarget[] = []
  const re = /<target\b([^>]*)>([\s\S]*?)<\/target>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    const portListMatch = /<port_list\b[^>]*\bid="([^"]*)"/.exec(body)
    out.push({
      id,
      // The target's own <name> is its first child (before nested port_list/task names).
      name: firstChildText(body, 'name') ?? '',
      hosts: firstChildText(body, 'hosts') ?? '',
      excludeHosts: firstChildText(body, 'exclude_hosts') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      portListId: portListMatch ? portListMatch[1] : null,
    })
  }
  return out
}

// =============================================================================
// Additional GMP entities — schedules, scan tasks, port lists, plus the read-only
// scan-config / scanner lookups scan tasks resolve their foreign keys against.
//
// Verified against python-gvm v224 request builders (GMP 22.4/22.5 share them) and
// the GMP 22.5 command reference (cite):
//   - https://docs.greenbone.net/API/GMP/gmp-22.5.html
//   - https://github.com/greenbone/python-gvm (gvm/protocols/gmp/requests/v224)
//
// FLAGS — GMP is version-specific; confirm against a live gvmd:
//   * SCHEDULES: create_schedule/modify_schedule take a single <icalendar> (RFC
//     5545 VCALENDAR/VEVENT with RRULE) + <timezone>. This is GMP 20.08+ — older
//     GMP (<= 9.0) used <first_time>/<period>/<period_unit>/<duration>/<byday>
//     instead. gvmd also STRIPS every VEVENT property except DTSTART, DTEND,
//     DURATION and RRULE and drops an undefined TZID, so the icalendar it echoes
//     back is reformatted — drift compares the meaningful keys, not the raw text.
//   * TASKS: create_task requires <usage_type>scan</usage_type> (GMP 9.0+) and
//     references its config/target/scanner as EMPTY id-bearing elements
//     (<config id="…"/>), NOT nested text. modify_task CANNOT re-point
//     config/target/scanner on a task that has already run unless the task is
//     alterable (gvmd issue #1305) — deploy only re-sends a foreign key that
//     actually changed so an unchanged re-deploy never trips this.
//   * PORT LISTS: modify_port_list only accepts <name>/<comment>; the port ranges
//     are immutable via modify (you would create_port_range/delete_port_range or
//     recreate the list). Deploy surfaces a changed range rather than silently
//     dropping it. get_port_lists returns ranges as structured <port_range>
//     <start>/<end>/<type> triples, not the compact "T:1-1024" input string.
// =============================================================================

// -----------------------------------------------------------------------------
// Schedules — <create_schedule> / <get_schedules> / <modify_schedule> / <delete_schedule>.
// -----------------------------------------------------------------------------

export function buildGetSchedulesCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_schedules filter="${escapeXmlAttr(filter)}"/>`
}

export interface ScheduleInput {
  name: string
  icalendar: string
  timezone: string
  comment?: string
}

export function buildCreateScheduleCommand(s: ScheduleInput): string {
  const parts = [
    `<name>${escapeXmlText(s.name)}</name>`,
    `<icalendar>${escapeXmlText(s.icalendar)}</icalendar>`,
    `<timezone>${escapeXmlText(s.timezone)}</timezone>`,
  ]
  if (s.comment && String(s.comment).trim()) parts.push(`<comment>${escapeXmlText(s.comment)}</comment>`)
  return `<create_schedule>${parts.join('')}</create_schedule>`
}

/** Modify a schedule. Only provided fields are sent; identity is the schedule_id attribute. */
export function buildModifyScheduleCommand(
  scheduleId: string,
  s: { name?: string; icalendar?: string; timezone?: string; comment?: string },
): string {
  const parts: string[] = []
  if (s.name !== undefined) parts.push(`<name>${escapeXmlText(s.name)}</name>`)
  if (s.icalendar !== undefined) parts.push(`<icalendar>${escapeXmlText(s.icalendar)}</icalendar>`)
  if (s.timezone !== undefined) parts.push(`<timezone>${escapeXmlText(s.timezone)}</timezone>`)
  if (s.comment !== undefined) parts.push(`<comment>${escapeXmlText(s.comment)}</comment>`)
  return `<modify_schedule schedule_id="${escapeXmlAttr(scheduleId)}">${parts.join('')}</modify_schedule>`
}

export function buildDeleteScheduleCommand(scheduleId: string, ultimate = true): string {
  return `<delete_schedule schedule_id="${escapeXmlAttr(scheduleId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpSchedule {
  id: string
  name: string
  comment: string
  icalendar: string
  timezone: string
}

/** Parse `<schedule id="…">…</schedule>` elements out of a get_schedules_response. */
export function parseSchedules(xml: string): GmpSchedule[] {
  const out: GmpSchedule[] = []
  const re = /<schedule\b([^>]*)>([\s\S]*?)<\/schedule>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    out.push({
      id,
      name: firstChildText(body, 'name') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      icalendar: firstChildText(body, 'icalendar') ?? '',
      timezone: firstChildText(body, 'timezone') ?? '',
    })
  }
  return out
}

// -----------------------------------------------------------------------------
// Scan tasks — <create_task> / <get_tasks> / <modify_task> / <delete_task>.
// -----------------------------------------------------------------------------

export function buildGetTasksCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_tasks usage_type="scan" filter="${escapeXmlAttr(filter)}"/>`
}

export interface TaskInput {
  name: string
  configId: string
  targetId: string
  scannerId: string
  scheduleId?: string
  comment?: string
}

export function buildCreateTaskCommand(t: TaskInput): string {
  const parts = [
    `<name>${escapeXmlText(t.name)}</name>`,
    '<usage_type>scan</usage_type>',
    `<config id="${escapeXmlAttr(t.configId)}"/>`,
    `<target id="${escapeXmlAttr(t.targetId)}"/>`,
    `<scanner id="${escapeXmlAttr(t.scannerId)}"/>`,
  ]
  if (t.comment && String(t.comment).trim()) parts.push(`<comment>${escapeXmlText(t.comment)}</comment>`)
  // id="0" means "no schedule"; only attach a real schedule on create.
  if (t.scheduleId && t.scheduleId !== '0') parts.push(`<schedule id="${escapeXmlAttr(t.scheduleId)}"/>`)
  return `<create_task>${parts.join('')}</create_task>`
}

/**
 * Modify a task. Only provided fields are sent; identity is the task_id attribute.
 * config/target/scanner are re-pointed via id-bearing elements — see the FLAG:
 * gvmd rejects re-pointing them on a task that has run unless it is alterable, so
 * callers should only pass a foreign key that actually changed. schedule_id "0"
 * clears the schedule.
 */
export function buildModifyTaskCommand(
  taskId: string,
  t: { name?: string; comment?: string; configId?: string; targetId?: string; scannerId?: string; scheduleId?: string },
): string {
  const parts: string[] = []
  if (t.name !== undefined) parts.push(`<name>${escapeXmlText(t.name)}</name>`)
  if (t.comment !== undefined) parts.push(`<comment>${escapeXmlText(t.comment)}</comment>`)
  if (t.configId !== undefined) parts.push(`<config id="${escapeXmlAttr(t.configId)}"/>`)
  if (t.targetId !== undefined) parts.push(`<target id="${escapeXmlAttr(t.targetId)}"/>`)
  if (t.scannerId !== undefined) parts.push(`<scanner id="${escapeXmlAttr(t.scannerId)}"/>`)
  if (t.scheduleId !== undefined) parts.push(`<schedule id="${escapeXmlAttr(t.scheduleId)}"/>`)
  return `<modify_task task_id="${escapeXmlAttr(taskId)}">${parts.join('')}</modify_task>`
}

export function buildDeleteTaskCommand(taskId: string, ultimate = true): string {
  return `<delete_task task_id="${escapeXmlAttr(taskId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpTask {
  id: string
  name: string
  comment: string
  targetId: string
  targetName: string
  configId: string
  configName: string
  scannerId: string
  scannerName: string
  scheduleId: string
  scheduleName: string
}

/**
 * Read a nested id-bearing child of a task body (target/config/scanner/schedule),
 * which gvmd returns either as `<tag id="…"><name>…</name>…</tag>` or, when unset,
 * as a self-closing `<tag id="0"/>`.
 */
function nestedRef(body: string, tag: string): { id: string; name: string } {
  const full = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`).exec(body)
  if (full) return { id: attrsFrom(full[1]).id ?? '', name: firstChildText(full[2], 'name') ?? '' }
  const selfClosing = new RegExp(`<${tag}\\b([^>]*?)/>`).exec(body)
  return { id: selfClosing ? (attrsFrom(selfClosing[1]).id ?? '') : '', name: '' }
}

/** Parse `<task id="…">…</task>` elements out of a get_tasks_response. */
export function parseTasks(xml: string): GmpTask[] {
  const out: GmpTask[] = []
  const re = /<task\b([^>]*)>([\s\S]*?)<\/task>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    const target = nestedRef(body, 'target')
    const config = nestedRef(body, 'config')
    const scanner = nestedRef(body, 'scanner')
    const schedule = nestedRef(body, 'schedule')
    out.push({
      id,
      // The task's own <name> is its first child (before nested target/config names).
      name: firstChildText(body, 'name') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      targetId: target.id,
      targetName: target.name,
      configId: config.id,
      configName: config.name,
      scannerId: scanner.id,
      scannerName: scanner.name,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
    })
  }
  return out
}

// -----------------------------------------------------------------------------
// Named-entity lookups — the read-only lists scan tasks resolve foreign keys
// against: scan configs (<get_configs usage_type="scan">) and scanners
// (<get_scanners>). Both answer `<config|scanner id="…"><name>…</name>…>`.
// -----------------------------------------------------------------------------

export function buildGetScanConfigsCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_configs usage_type="scan" filter="${escapeXmlAttr(filter)}"/>`
}

export function buildGetScannersCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_scanners filter="${escapeXmlAttr(filter)}"/>`
}

export interface GmpNamedRef {
  id: string
  name: string
}

/** Parse `<tag id="…"><name>…</name>…</tag>` entities (config/scanner) by id + name. */
export function parseNamedRefs(xml: string, tag: string): GmpNamedRef[] {
  const out: GmpNamedRef[] = []
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    out.push({ id, name: firstChildText(m[2], 'name') ?? '' })
  }
  return out
}

export const parseScanConfigs = (xml: string): GmpNamedRef[] => parseNamedRefs(xml, 'config')
export const parseScanners = (xml: string): GmpNamedRef[] => parseNamedRefs(xml, 'scanner')

// -----------------------------------------------------------------------------
// Port lists — <create_port_list> / <get_port_lists> / <modify_port_list> / <delete_port_list>.
// -----------------------------------------------------------------------------

export function buildGetPortListsCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  // details=1 so the structured <port_ranges> come back for drift comparison.
  return `<get_port_lists details="1" filter="${escapeXmlAttr(filter)}"/>`
}

export interface PortListInput {
  name: string
  portRange: string
  comment?: string
}

export function buildCreatePortListCommand(p: PortListInput): string {
  const parts = [
    `<name>${escapeXmlText(p.name)}</name>`,
    `<port_range>${escapeXmlText(p.portRange)}</port_range>`,
  ]
  if (p.comment && String(p.comment).trim()) parts.push(`<comment>${escapeXmlText(p.comment)}</comment>`)
  return `<create_port_list>${parts.join('')}</create_port_list>`
}

/**
 * Modify a port list. gvmd only lets name/comment change here (see FLAG) — the
 * port ranges are immutable via modify, so this builder deliberately takes no
 * range argument.
 */
export function buildModifyPortListCommand(
  portListId: string,
  p: { name?: string; comment?: string },
): string {
  const parts: string[] = []
  if (p.name !== undefined) parts.push(`<name>${escapeXmlText(p.name)}</name>`)
  if (p.comment !== undefined) parts.push(`<comment>${escapeXmlText(p.comment)}</comment>`)
  return `<modify_port_list port_list_id="${escapeXmlAttr(portListId)}">${parts.join('')}</modify_port_list>`
}

export function buildDeletePortListCommand(portListId: string, ultimate = true): string {
  return `<delete_port_list port_list_id="${escapeXmlAttr(portListId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpPortList {
  id: string
  name: string
  comment: string
  /** Canonical compact range string reconstructed from the structured response, e.g. "T:1-1024,U:53". */
  portRange: string
}

/**
 * Rebuild the compact "T:1-1024,U:53" form from the structured <port_ranges> gvmd
 * returns (`<port_range><start>1</start><end>1024</end><type>TCP</type>`), sorted
 * so it compares canonically regardless of the order gvmd lists them.
 */
function portRangesToCompact(body: string): string {
  const tokens: string[] = []
  const re = /<port_range\b[^>]*>([\s\S]*?)<\/port_range>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const inner = m[1]
    const start = firstChildText(inner, 'start')
    const end = firstChildText(inner, 'end')
    const type = (firstChildText(inner, 'type') ?? '').toUpperCase()
    if (!start) continue
    const prefix = type === 'UDP' ? 'U' : 'T'
    tokens.push(end && end !== start ? `${prefix}:${start}-${end}` : `${prefix}:${start}`)
  }
  return tokens.sort().join(',')
}

/** Parse `<port_list id="…">…</port_list>` elements out of a get_port_lists_response. */
export function parsePortLists(xml: string): GmpPortList[] {
  const out: GmpPortList[] = []
  const re = /<port_list\b([^>]*)>([\s\S]*?)<\/port_list>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    out.push({
      id,
      name: firstChildText(body, 'name') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      portRange: portRangesToCompact(body),
    })
  }
  return out
}

/**
 * Has a complete top-level GMP response arrived? GMP is not length-framed, so the
 * reader accumulates until the single response element is closed. Minimal detector
 * (see FLAGS): reads the root name, returns true on a self-closing root or once the
 * matching `</root>` is present.
 */
export function isCompleteGmpResponse(buffer: string): boolean {
  const s = String(buffer ?? '').replace(/^﻿/, '').replace(/^\s+/, '')
  const m = /^<([A-Za-z_][\w.:-]*)/.exec(s)
  if (!m) return false
  const root = m[1]
  let i = m[0].length
  let quote: string | null = null
  for (; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '>') {
      if (s[i - 1] === '/') return true // self-closing root, e.g. create_target_response
      break
    }
  }
  if (i >= s.length) return false // opening tag not finished
  return s.includes(`</${root}>`)
}

// -----------------------------------------------------------------------------
// Transport — a TLS socket that speaks GMP.
// -----------------------------------------------------------------------------

export interface GmpConnectOptions {
  host: string
  port?: number
  /** gvmd usually ships a self-signed cert; defaults to false (tolerate it). */
  rejectUnauthorized?: boolean
  /** Per-command + connect timeout (ms). */
  timeoutMs?: number
}

export class GmpError extends Error {
  status: string
  statusText: string
  constructor(message: string, status = '', statusText = '') {
    super(message)
    this.name = 'GmpError'
    this.status = status
    this.statusText = statusText
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Read exactly one GMP response element off the socket. */
function readGmpResponse(socket: TLSSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onErr)
      socket.removeListener('end', onEnd)
    }
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      if (isCompleteGmpResponse(buf)) {
        cleanup()
        resolve(buf.trim())
      }
    }
    const onErr = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onEnd = () => {
      cleanup()
      if (isCompleteGmpResponse(buf)) resolve(buf.trim())
      else reject(new GmpError('Connection closed before a complete GMP response arrived'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new GmpError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a GMP response`))
    }, timeoutMs)
    socket.on('data', onData)
    socket.once('error', onErr)
    socket.once('end', onEnd)
  })
}

/**
 * A single authenticated GMP conversation over one TLS socket. Prefer
 * withGmpSession(), which connects, authenticates, runs your work and always
 * closes the socket.
 */
export class GmpSession {
  private constructor(
    private readonly socket: TLSSocket,
    private readonly timeoutMs: number,
  ) {}

  static connect(opts: GmpConnectOptions): Promise<GmpSession> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const port = opts.port ?? DEFAULT_GMP_PORT
    return new Promise((resolve, reject) => {
      let settled = false
      const socket = tlsConnect(
        {
          host: opts.host,
          port,
          servername: opts.host,
          rejectUnauthorized: opts.rejectUnauthorized ?? false,
        },
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          socket.removeListener('error', onErr)
          resolve(new GmpSession(socket, timeoutMs))
        },
      )
      const onErr = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        reject(err)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(new GmpError(`Timed out after ${Math.round(timeoutMs / 1000)}s connecting to ${opts.host}:${port}`))
      }, timeoutMs)
      socket.once('error', onErr)
    })
  }

  /** Send one raw GMP command and return the raw XML response. */
  async send(xml: string): Promise<string> {
    this.socket.write(xml)
    return readGmpResponse(this.socket, this.timeoutMs)
  }

  /** Authenticate this connection. Throws GmpError on a non-2xx status. */
  async authenticate(username: string, password: string): Promise<GmpStatus> {
    const raw = await this.send(buildAuthenticateCommand(username, password))
    const st = parseGmpStatus(raw)
    if (!st.ok) {
      throw new GmpError(
        `GMP authentication failed (status ${st.status || '?'}${st.statusText ? `: ${st.statusText}` : ''})`,
        st.status,
        st.statusText,
      )
    }
    return st
  }

  close(): void {
    try {
      this.socket.end()
      this.socket.destroy()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Connect + authenticate + run `fn` on the live session, always closing the
 * socket. The single place handlers touch the transport.
 */
export async function withGmpSession<T>(
  opts: GmpConnectOptions,
  credentials: { username: string; password: string },
  fn: (session: GmpSession) => Promise<T>,
): Promise<T> {
  const session = await GmpSession.connect(opts)
  try {
    await session.authenticate(credentials.username, credentials.password)
    return await fn(session)
  } finally {
    session.close()
  }
}

// -----------------------------------------------------------------------------
// Endpoint resolution (host/port) from platform refs.
// -----------------------------------------------------------------------------

/** Prefer a ZTNA device IP when present, else the component hostname. */
export function resolveGmpHost(component: ComponentRef, connectivity: ConnectivityRef | null): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  return component.hostname
}

/** GMP port: the app setting (gmp_port) wins, then the component port, else 9390. */
export function resolveGmpPort(component: ComponentRef, settingPort?: unknown): number {
  const fromSetting = Number(settingPort)
  if (Number.isFinite(fromSetting) && fromSetting > 0) return fromSetting
  const fromComponent = Number(component.port)
  if (Number.isFinite(fromComponent) && fromComponent > 0) return fromComponent
  return DEFAULT_GMP_PORT
}
