// Build the request-routing model for an app: for each operation, WHO is
// involved and HOW a request moves hop-by-hop to completion — including the
// governance hops (permission check, approval gate), the credential seam, and
// the target environment — plus how the operations connect into a lifecycle.
//
// Derived from the app's manifest (ops, permissions, credential/connectivity
// seams); the platform lifecycle + governance is uniform, so this generalizes.
//
// A step is { from, to, text, dashed, note }. dashed = a return/response.
// The same steps drive both the Mermaid sequence diagrams and the interactive
// stepper (one source of truth).

function participant(key, name, sub) {
  return { key, name, sub }
}

// Standard deployment environments (platform-defined classes). Connections are
// environment-scoped; promotion to production requires approval.
const ENVIRONMENTS = [
  { name: 'dev', approval: false },
  { name: 'staging', approval: false },
  { name: 'production', approval: true },
]

export function buildFlows(model) {
  const apiName = `${model.name} API`
  const adapterSub = model.adapters.length ? model.adapters.slice(0, 4).join(' · ') : 'lib/'
  const vault = model.requiresCredential
  const remote = model.requiresConnectivity
  const res = model.sampleResource

  const P = {
    operator: participant('operator', 'Operator / API', 'human or CI'),
    canvas: participant('canvas', 'Config Canvas', 'config as code'),
    page: participant('page', 'Connections', 'settings page'),
    pipeline: participant('pipeline', 'Pipeline', 'validate·deploy·drift·rollback'),
    rbac: participant('rbac', 'Access · RBAC', 'permission check'),
    approval: participant('approval', 'Approval gate', 'human-in-the-loop'),
    handler: participant('handler', 'App handler', 'SDK ctx'),
    vault: participant('vault', 'Credential Vault', 'resolveConnection'),
    remote: participant('remote', 'Network / ZTNA', 'ctx.remote'),
    adapter: participant('adapter', 'Adapter', adapterSub),
    api: participant('api', apiName, model.vendor ? `by ${model.vendor}` : ''),
  }

  const platformPerms = model.permissions.platform.join(' · ') || 'platform scopes'
  // A permission-check hop (always present — every operation authorizes first).
  const authz = (perms) => [
    { from: 'pipeline', to: 'rbac', text: 'authorize actor (RBAC)', note: perms },
    { from: 'rbac', to: 'pipeline', text: 'permitted ✓ / denied', dashed: true },
  ]
  // A human approval gate (write operations; enforced for production).
  const approve = () => [
    { from: 'pipeline', to: 'approval', text: 'request approval', note: 'required for production · human-in-the-loop' },
    { from: 'approval', to: 'pipeline', text: 'approved by a human — AI cannot self-approve', dashed: true },
  ]
  const cred = () =>
    vault
      ? [
          { from: 'handler', to: 'vault', text: 'resolveConnection (env-scoped connection)' },
          { from: 'vault', to: 'handler', text: 'decrypted credential', dashed: true },
        ]
      : []
  const net = () => (remote ? [{ from: 'handler', to: 'remote', text: 'open ctx.remote channel' }] : [])

  const appliesToAll = `${model.counts.vendorTypes} config types · ${model.counts.families} API families`
  const parts = (...keys) => keys.filter((k) => (k === 'vault' ? vault : k === 'remote' ? remote : true))

  const operations = []

  if (model.ops.deploy) {
    operations.push({
      key: 'deploy',
      title: 'Deploy a configuration',
      when: 'You publish or change a config (e.g. a policy, rule, or exclusion).',
      appliesTo: appliesToAll,
      participants: parts('operator', 'canvas', 'pipeline', 'rbac', 'approval', 'handler', 'vault', 'remote', 'adapter', 'api'),
      steps: [
        { from: 'operator', to: 'canvas', text: 'author config (typed fields)' },
        { from: 'canvas', to: 'pipeline', text: 'submit for deploy → target environment' },
        ...authz(`${platformPerms} + ${res}:write`),
        { from: 'pipeline', to: 'handler', text: 'validate(config)', note: 'schema + business rules' },
        { from: 'handler', to: 'pipeline', text: 'valid ✓ / errors', dashed: true },
        ...approve(),
        { from: 'pipeline', to: 'handler', text: 'deploy(config, ctx)' },
        ...cred(),
        ...net(),
        { from: 'handler', to: 'adapter', text: 'map canvas → API shape' },
        { from: 'adapter', to: 'api', text: 'create / update resource (write ▶)' },
        { from: 'api', to: 'adapter', text: 'resource id(s)', dashed: true },
        { from: 'adapter', to: 'handler', text: 'applied result', dashed: true },
        { from: 'handler', to: 'pipeline', text: 'status + rollbackData (prior state)', dashed: true },
        { from: 'pipeline', to: 'canvas', text: 'deployed ✓ to the environment — snapshot stored', dashed: true },
      ],
    })
  }

  if (model.ops.drift) {
    operations.push({
      key: 'drift',
      title: 'Detect drift',
      when: 'A scheduled sweep or on-demand check reconciles live state against the canvas.',
      appliesTo: appliesToAll,
      participants: parts('operator', 'pipeline', 'rbac', 'handler', 'vault', 'adapter', 'api'),
      steps: [
        { from: 'operator', to: 'pipeline', text: 'scheduled sweep / on-demand' },
        ...authz(`component:read + ${res}:read`),
        { from: 'pipeline', to: 'handler', text: 'driftDetect(ctx, snapshot)' },
        ...cred(),
        { from: 'handler', to: 'adapter', text: 'fetch live state' },
        { from: 'adapter', to: 'api', text: 'read resource (read ◀)' },
        { from: 'api', to: 'adapter', text: 'live config', dashed: true },
        { from: 'adapter', to: 'handler', text: 'normalized live', dashed: true },
        { from: 'handler', to: 'handler', text: 'diff vs snapshot → DriftDiff[] (per-field actor)' },
        { from: 'handler', to: 'pipeline', text: 'in-sync ✓ or drift found', dashed: true },
        { from: 'pipeline', to: 'operator', text: 'drift status → Correct / Acknowledge', dashed: true },
      ],
    })
  }

  if (model.ops.rollback) {
    operations.push({
      key: 'rollback',
      title: 'Roll back',
      when: 'Revert a config to its previously-deployed state using the stored rollbackData.',
      appliesTo: appliesToAll,
      participants: parts('operator', 'pipeline', 'rbac', 'approval', 'handler', 'vault', 'adapter', 'api'),
      steps: [
        { from: 'operator', to: 'pipeline', text: 'roll back to prior version' },
        ...authz(`${res}:write`),
        ...approve(),
        { from: 'pipeline', to: 'handler', text: 'rollback(rollbackData, ctx)' },
        ...cred(),
        { from: 'handler', to: 'adapter', text: 'apply prior state' },
        { from: 'adapter', to: 'api', text: 'restore resource (write ▶)' },
        { from: 'api', to: 'adapter', text: 'ok', dashed: true },
        { from: 'adapter', to: 'handler', text: 'restored', dashed: true },
        { from: 'handler', to: 'pipeline', text: 'rolled back ✓', dashed: true },
      ],
    })
  }

  if (model.ops.testConnection) {
    operations.push({
      key: 'connect',
      title: 'Test connection',
      when: 'Verify a tenant credential before any deploy or drift can run.',
      appliesTo: 'precondition for every operation',
      participants: parts('operator', 'page', 'rbac', 'handler', 'vault', 'api'),
      steps: [
        { from: 'operator', to: 'page', text: 'enter / select credential (per environment)' },
        ...[
          { from: 'page', to: 'rbac', text: 'authorize (RBAC)', note: 'credential:read' },
          { from: 'rbac', to: 'page', text: 'permitted ✓', dashed: true },
        ],
        { from: 'page', to: 'handler', text: 'testConnection(ctx)' },
        ...(vault
          ? [
              { from: 'handler', to: 'vault', text: 'resolveConnection' },
              { from: 'vault', to: 'handler', text: 'credential', dashed: true },
            ]
          : []),
        { from: 'handler', to: 'api', text: 'auth probe (token → whoami)' },
        { from: 'api', to: 'handler', text: '200 / 401', dashed: true },
        { from: 'handler', to: 'page', text: 'connected ✓ / failed', dashed: true },
      ],
    })
  }

  const lifecycle = {
    nodes: [
      { id: 'connect', label: 'Test connection', kind: 'pre', on: model.ops.testConnection },
      { id: 'author', label: 'Author config', kind: 'start', on: true },
      { id: 'authz', label: 'Permission check', kind: 'gate', on: true },
      { id: 'validate', label: 'Validate', kind: 'step', on: true },
      { id: 'approve', label: 'Approval gate', kind: 'gate', on: model.ops.deploy },
      { id: 'deploy', label: 'Deploy ▶ (write)', kind: 'act', on: model.ops.deploy },
      { id: 'live', label: 'Live & monitored', kind: 'state', on: true },
      { id: 'drift', label: 'Drift detect ◀ (read)', kind: 'act', on: model.ops.drift },
      { id: 'correct', label: 'Correct (re-deploy)', kind: 'act', on: model.ops.deploy },
      { id: 'rollback', label: 'Roll back', kind: 'act', on: model.ops.rollback },
    ].filter((n) => n.on),
    edges: [
      ['connect', 'authz', 'enables'],
      ['author', 'authz', ''],
      ['authz', 'validate', 'permitted'],
      ['validate', 'approve', 'valid'],
      ['approve', 'deploy', 'approved'],
      ['deploy', 'live', 'to env · stored'],
      ['live', 'drift', 'sweep'],
      ['drift', 'live', 'in sync ✓'],
      ['drift', 'correct', 'drift found'],
      ['correct', 'live', ''],
      ['drift', 'rollback', 'revert'],
      ['rollback', 'live', ''],
    ],
  }

  return { participants: P, operations, lifecycle, environments: ENVIRONMENTS }
}
