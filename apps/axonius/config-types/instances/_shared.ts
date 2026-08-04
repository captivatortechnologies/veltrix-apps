// Shared helpers for the Axonius Instances config type (deploy + rollback +
// drift + validate). An Axonius instance is a cluster node (the core / master,
// or a collector node) that joins the cluster through its own installer — this
// config type is UPDATE-ONLY: it never creates or deletes an instance, only
// renames/re-labels one that already exists, identified by its node_id.
//
// Deliberately NOT managed here (see README Coverage): deactivating a node and
// setting/removing instance tags. Both are listed by the axonius_api_client
// maintainers themselves as "not yet exposed" in their own `Instances` wrapper
// docstring, even though a raw `update_active` endpoint exists — so this config
// type only drives the fields the maintained client itself round-trips
// (node_name / hostname / use_as_environment_name via `_update_attrs`).
//
// Endpoints (verified against axonius_api_client master — api_endpoints.py,
// json_api/instances.py, api/system/instances.py):
//   GET api/instances  list every instance (type_ instances_schema)
//   PUT api/instances  update attrs — body is FLAT, NOT JSON:API-wrapped
//                       (InstanceUpdateAttributesRequest.get_schema_cls() ->
//                       None, so BaseModel.dump_request skips the
//                       {data:{type,attributes}} envelope entirely — verified
//                       against json_api/base.py's dump_request). Body:
//                       { nodeIds: "<node_id>", node_name, hostname, use_as_environment_name }
//                       (nodeIds is a single node_id string, not an array —
//                       verified against api/system/instances.py's _update_attrs).

/** GET — list every instance (cluster node). */
export const INSTANCES_LIST_RESOURCE = 'instances'
/** PUT — update an instance's attrs. Same path for every instance; the target is named in the body's `nodeIds`. */
export const UPDATE_INSTANCE_RESOURCE = 'instances'

/** The subset of a live Axonius instance this config type reads and manages. */
export interface AxoniusInstance {
  id?: string
  node_id?: string
  node_name?: string
  hostname?: string
  use_as_environment_name?: boolean
  is_master?: boolean
  status?: string
  [key: string]: unknown
}

/** Flat (non-JSON:API) body for `PUT api/instances` update_attrs. */
export interface InstanceUpdateAttributesBody {
  nodeIds: string
  node_name: string
  hostname: string
  use_as_environment_name: boolean
}

// --- Field parsing --------------------------------------------------------

/** Trim a string canvas value. */
export function parseText(value: unknown): string {
  return String(value ?? '').trim()
}

/** Read a `checkbox` canvas field as a strict boolean. */
export function parseBool(value: unknown): boolean {
  return value === true || value === 'true'
}

// --- Body building --------------------------------------------------------

/** Build the flat update_attrs body — see the file header for why this is NOT JSON:API-wrapped. */
export function buildUpdateAttrsBody(fields: {
  nodeId: string
  nodeName: string
  hostname: string
  useAsEnvironmentName: boolean
}): InstanceUpdateAttributesBody {
  return {
    nodeIds: fields.nodeId,
    node_name: fields.nodeName,
    hostname: fields.hostname,
    use_as_environment_name: fields.useAsEnvironmentName,
  }
}

/** Build the flat update_attrs body that restores a prior instance snapshot verbatim (used by rollback). */
export function buildRestoreBody(nodeId: string, attributes: Record<string, unknown>): InstanceUpdateAttributesBody {
  return buildUpdateAttrsBody({
    nodeId,
    nodeName: String(attributes.node_name ?? ''),
    hostname: String(attributes.hostname ?? ''),
    useAsEnvironmentName: attributes.use_as_environment_name === true,
  })
}

// --- Response parsing ---------------------------------------------------------

/** Flatten a JSON:API `{ data: [ { id, attributes } ] }` list into instances. */
export function instancesFromResponse(json: unknown): AxoniusInstance[] {
  const data = (json as { data?: unknown })?.data
  const rows = Array.isArray(data) ? data : Array.isArray(json) ? (json as unknown[]) : []
  return rows.map((row) => {
    if (row && typeof row === 'object' && 'attributes' in (row as Record<string, unknown>)) {
      const r = row as { id?: string; attributes?: Record<string, unknown> }
      return { id: r.id, node_id: (r.attributes?.node_id as string) ?? r.id, ...(r.attributes ?? {}) } as AxoniusInstance
    }
    return row as AxoniusInstance
  })
}

/** Find a live instance by its node_id — the stable identity this config type reconciles by (never created here). */
export function findInstance(list: AxoniusInstance[], nodeId: string): AxoniusInstance | null {
  const n = nodeId.trim()
  if (!n) return null
  return list.find((i) => String(i.node_id ?? i.id ?? '').trim() === n) ?? null
}
