// =============================================================================
// Traffic Shaper resources — pipes, queues and rules
// (api/trafficshaper/settings/*, api/trafficshaper/service/reconfigure).
//
// Verified: src/opnsense/mvc/app/controllers/OPNsense/TrafficShaper/Api/
// SettingsController.php + src/opnsense/mvc/app/models/OPNsense/
// TrafficShaper/TrafficShaper.xml (mount //OPNsense/TrafficShaper — ONE
// model backs all three resources below). No meaningful version floor — this
// controller predates 2020 (file copyright 2015-2017).
//
// `number` (pipe/queue's pf dnpipe/queue identifier) is SERVER-ASSIGNED:
// `addPipeAction`/`addQueueAction` overlay `{origin: "TrafficShaper", number:
// (new TrafficShaper())->newPipeNumber()/newQueueNumber()}` onto the posted
// body via addBase()'s 3rd (overlay) parameter, which OVERWRITES whatever we
// send for those two keys — so PipeBody/QueueBody below don't even declare
// them; the response's `uuid` is this app's only handle on a created pipe or
// queue, exactly like every other resource in this app.
// =============================================================================

import { buildModelResource, reconfigureModule, type ModelRecord, type ModelResource, type ModelVerbs, type OpnsenseClient } from './opnsenseCore'

export const TRAFFICSHAPER_SETTINGS_MODULE = ['trafficshaper', 'settings'] as const
export const TRAFFICSHAPER_SERVICE_MODULE = ['trafficshaper', 'service'] as const

// --- Pipes (pipes.pipe) ---------------------------------------------------------

const PIPE_VERBS: ModelVerbs = { search: 'searchPipes', add: 'addPipe', set: 'setPipe', del: 'delPipe' }

export interface PipeBody {
  enabled: string
  bandwidth: string
  bandwidthMetric: string // "bit" | "Kbit" | "Mbit" | "Gbit"
  queue: string // queue (bucket) size, 2-100 — optional
  mask: string // "none" | "src-ip" | "dst-ip" | "src-ip6" | "dst-ip6"
  buckets: string
  scheduler: string // "" (WFQ default) | "fifo" | "rr" | "qfq" | "fq_codel" | "fq_pie"
  codel_enable: string
  codel_target: string
  codel_interval: string
  codel_ecn_enable: string
  pie_enable: string
  fqcodel_quantum: string
  fqcodel_limit: string
  fqcodel_flows: string
  delay: string
  description: string
}

export interface LivePipe extends ModelRecord {
  number?: string
  enabled?: string
  bandwidth?: string
  bandwidthMetric?: string
  description?: string
  [key: string]: unknown
}

function pipeResource(client: OpnsenseClient): ModelResource<LivePipe, PipeBody> {
  return buildModelResource<LivePipe, PipeBody>(client, TRAFFICSHAPER_SETTINGS_MODULE, 'pipe', PIPE_VERBS)
}

/** `GET|POST /api/trafficshaper/settings/searchPipes` — `searchBase`-backed, `rowCount: -1` default. */
export function searchPipes(client: OpnsenseClient): Promise<LivePipe[]> {
  return pipeResource(client).search()
}

/** `POST /api/trafficshaper/settings/addPipe` — body `{ pipe: {...} }` (server assigns `number`). Returns the new uuid. */
export function addPipe(client: OpnsenseClient, body: PipeBody): Promise<string> {
  return pipeResource(client).add(body)
}

/** `POST /api/trafficshaper/settings/setPipe/<uuid>` — body `{ pipe: {...} }`. */
export function setPipe(client: OpnsenseClient, uuid: string, body: PipeBody): Promise<void> {
  return pipeResource(client).set(uuid, body)
}

/** `POST /api/trafficshaper/settings/delPipe/<uuid>` (safe-delete: rejects if a queue/rule still targets this pipe). */
export function deletePipe(client: OpnsenseClient, uuid: string): Promise<void> {
  return pipeResource(client).remove(uuid)
}

// --- Queues (queues.queue) -------------------------------------------------------

const QUEUE_VERBS: ModelVerbs = { search: 'searchQueues', add: 'addQueue', set: 'setQueue', del: 'delQueue' }

export interface QueueBody {
  enabled: string
  pipe: string // resolved pipe uuid (ModelRelationField, displayed/matched by the pipe's description)
  weight: string
  mask: string
  buckets: string
  codel_enable: string
  codel_target: string
  codel_interval: string
  codel_ecn_enable: string
  pie_enable: string
  description: string
}

export interface LiveQueue extends ModelRecord {
  number?: string
  enabled?: string
  pipe?: string
  weight?: string
  description?: string
  [key: string]: unknown
}

function queueResource(client: OpnsenseClient): ModelResource<LiveQueue, QueueBody> {
  return buildModelResource<LiveQueue, QueueBody>(client, TRAFFICSHAPER_SETTINGS_MODULE, 'queue', QUEUE_VERBS)
}

/** `GET|POST /api/trafficshaper/settings/searchQueues` — `rowCount: -1` default. */
export function searchQueues(client: OpnsenseClient): Promise<LiveQueue[]> {
  return queueResource(client).search()
}

/** `POST /api/trafficshaper/settings/addQueue` — body `{ queue: {...} }` (server assigns `number`). Returns the new uuid. */
export function addQueue(client: OpnsenseClient, body: QueueBody): Promise<string> {
  return queueResource(client).add(body)
}

/** `POST /api/trafficshaper/settings/setQueue/<uuid>` — body `{ queue: {...} }`. */
export function setQueue(client: OpnsenseClient, uuid: string, body: QueueBody): Promise<void> {
  return queueResource(client).set(uuid, body)
}

/** `POST /api/trafficshaper/settings/delQueue/<uuid>`. */
export function deleteQueue(client: OpnsenseClient, uuid: string): Promise<void> {
  return queueResource(client).remove(uuid)
}

// --- Rules (rules.rule, TrafficShaper's OWN — not Firewall's) ------------------

const SHAPER_RULE_VERBS: ModelVerbs = { search: 'searchRules', add: 'addRule', set: 'setRule', del: 'delRule' }

export interface ShaperRuleBody {
  enabled: string
  sequence: string
  interface: string
  interface2: string
  proto: string // "ip" (default) | "ip4" | "ip6" | "udp" | "tcp" | ... (see model's OptionValues)
  iplen: string
  source: string // AsList — comma-joined
  source_not: string
  src_port: string
  destination: string // AsList — comma-joined
  destination_not: string
  dst_port: string
  dscp: string // Multiple — comma-joined
  direction: string // "" (both) | "in" | "out"
  target: string // resolved pipe-OR-queue uuid (ModelRelationField, matched by description)
  description: string
}

export interface LiveShaperRule extends ModelRecord {
  enabled?: string
  sequence?: string
  interface?: string
  proto?: string
  source?: string
  destination?: string
  target?: string
  description?: string
  [key: string]: unknown
}

function shaperRuleResource(client: OpnsenseClient): ModelResource<LiveShaperRule, ShaperRuleBody> {
  return buildModelResource<LiveShaperRule, ShaperRuleBody>(client, TRAFFICSHAPER_SETTINGS_MODULE, 'rule', SHAPER_RULE_VERBS)
}

/** `GET|POST /api/trafficshaper/settings/searchRules` — sorted by `sequence`, `rowCount: -1` default. */
export function searchShaperRules(client: OpnsenseClient): Promise<LiveShaperRule[]> {
  return shaperRuleResource(client).search()
}

/** `POST /api/trafficshaper/settings/addRule` — body `{ rule: {...} }`. Returns the new uuid. */
export function addShaperRule(client: OpnsenseClient, body: ShaperRuleBody): Promise<string> {
  return shaperRuleResource(client).add(body)
}

/** `POST /api/trafficshaper/settings/setRule/<uuid>` — body `{ rule: {...} }`. */
export function setShaperRule(client: OpnsenseClient, uuid: string, body: ShaperRuleBody): Promise<void> {
  return shaperRuleResource(client).set(uuid, body)
}

/** `POST /api/trafficshaper/settings/delRule/<uuid>`. */
export function deleteShaperRule(client: OpnsenseClient, uuid: string): Promise<void> {
  return shaperRuleResource(client).remove(uuid)
}

// --- Apply (shared by pipes/queues/rules) ---------------------------------------

/**
 * `POST /api/trafficshaper/service/reconfigure` — verified custom override
 * (NOT the generic ApiMutableServiceControllerBase): reloads the `OPNsense/
 * Shaper` and `OPNsense/IPFW` templates then runs `shaper reload` and
 * `ipfw reload`, returning the literal `{"status":"ok"}` only if BOTH
 * backend reloads report `"OK"` — otherwise `{"status":"error reloading
 * shaper (...)"}` / `{"status":"error reloading ipfw (...)"}`.
 */
export function reconfigureTrafficShaper(client: OpnsenseClient): Promise<void> {
  return reconfigureModule(client, TRAFFICSHAPER_SERVICE_MODULE)
}
