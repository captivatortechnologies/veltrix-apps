// Build the request-routing model for an app: for each operation, WHO is
// involved and HOW a request moves hop-by-hop to completion — plus how the
// operations connect into a lifecycle. Derived from the app's ops + seams; the
// platform lifecycle is uniform, so this generalizes across all apps.
//
// A step is { from, to, text, dashed, note } where from/to are participant keys.
// dashed = a return/response message. The same steps drive both the Mermaid
// sequence diagrams and the interactive stepper (one source of truth).

function participant(key, name, sub) {
  return { key, name, sub }
}

export function buildFlows(model) {
  const apiName = `${model.name} API`
  const adapterSub = model.adapters.length ? model.adapters.slice(0, 4).join(' · ') : 'lib/'
  const vault = model.requiresCredential
  const remote = model.requiresConnectivity

  // Canonical participants; each operation picks the subset it uses.
  const P = {
    operator: participant('operator', 'Operator / API', 'human or CI'),
    canvas: participant('canvas', 'Config Canvas', 'config as code'),
    page: participant('page', 'Connections', 'settings page'),
    pipeline: participant('pipeline', 'Pipeline', 'validate·deploy·drift·rollback'),
    handler: participant('handler', 'App handler', 'SDK ctx'),
    vault: participant('vault', 'Credential Vault', 'resolveConnection'),
    remote: participant('remote', 'Network / ZTNA', 'ctx.remote'),
    adapter: participant('adapter', 'Adapter', adapterSub),
    api: participant('api', apiName, model.vendor ? `by ${model.vendor}` : ''),
  }

  const credStep = (to) =>
    vault ? [{ from: 'handler', to: 'vault', text: 'resolveConnection(credentialId)' }, { from: 'vault', to: 'handler', text: 'decrypted credential', dashed: true }] : []
  const remoteStep = () =>
    remote ? [{ from: 'handler', to: 'remote', text: 'open ctx.remote channel' }] : []

  const vendorTypeCount = model.counts.vendorTypes
  const familyCount = model.counts.families
  const appliesToAll = `${vendorTypeCount} config types · ${familyCount} API families`

  const operations = []

  if (model.ops.deploy) {
    operations.push({
      key: 'deploy',
      title: 'Deploy a configuration',
      when: 'You publish or change a config (e.g. a policy, rule, or exclusion).',
      appliesTo: appliesToAll,
      participants: ['operator', 'canvas', 'pipeline', 'handler', ...(vault ? ['vault'] : []), ...(remote ? ['remote'] : []), 'adapter', 'api'],
      steps: [
        { from: 'operator', to: 'canvas', text: 'author config (typed fields)' },
        { from: 'canvas', to: 'pipeline', text: 'submit for deploy' },
        { from: 'pipeline', to: 'handler', text: 'validate(config)', note: 'schema + business rules' },
        { from: 'handler', to: 'pipeline', text: 'valid ✓ / errors', dashed: true },
        { from: 'pipeline', to: 'handler', text: 'deploy(config, ctx)' },
        ...credStep(),
        ...remoteStep(),
        { from: 'handler', to: 'adapter', text: 'map canvas → API shape' },
        { from: 'adapter', to: 'api', text: 'create / update resource (write ▶)' },
        { from: 'api', to: 'adapter', text: 'resource id(s)', dashed: true },
        { from: 'adapter', to: 'handler', text: 'applied result', dashed: true },
        { from: 'handler', to: 'pipeline', text: 'status + rollbackData (prior state)', dashed: true },
        { from: 'pipeline', to: 'canvas', text: 'deployed ✓ — snapshot stored', dashed: true },
      ],
    })
  }

  if (model.ops.drift) {
    operations.push({
      key: 'drift',
      title: 'Detect drift',
      when: 'A scheduled sweep or on-demand check reconciles live state against the canvas.',
      appliesTo: appliesToAll,
      participants: ['operator', 'pipeline', 'handler', ...(vault ? ['vault'] : []), 'adapter', 'api'],
      steps: [
        { from: 'operator', to: 'pipeline', text: 'scheduled sweep / on-demand' },
        { from: 'pipeline', to: 'handler', text: 'driftDetect(ctx, snapshot)' },
        ...credStep(),
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
      participants: ['operator', 'pipeline', 'handler', ...(vault ? ['vault'] : []), 'adapter', 'api'],
      steps: [
        { from: 'operator', to: 'pipeline', text: 'roll back to prior version' },
        { from: 'pipeline', to: 'handler', text: 'rollback(rollbackData, ctx)' },
        ...credStep(),
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
      participants: ['operator', 'page', 'handler', ...(vault ? ['vault'] : []), 'api'],
      steps: [
        { from: 'operator', to: 'page', text: 'enter / select credential' },
        { from: 'page', to: 'handler', text: 'testConnection(ctx)' },
        ...(vault ? [{ from: 'handler', to: 'vault', text: 'resolveConnection', }, { from: 'vault', to: 'handler', text: 'credential', dashed: true }] : []),
        { from: 'handler', to: 'api', text: 'auth probe (token → whoami)' },
        { from: 'api', to: 'handler', text: '200 / 401', dashed: true },
        { from: 'handler', to: 'page', text: 'connected ✓ / failed', dashed: true },
      ],
    })
  }

  // How the operations connect — the lifecycle a config moves through.
  const lifecycle = {
    nodes: [
      { id: 'connect', label: 'Test connection', kind: 'pre', on: model.ops.testConnection },
      { id: 'author', label: 'Author config', kind: 'start', on: true },
      { id: 'validate', label: 'Validate', kind: 'step', on: true },
      { id: 'deploy', label: 'Deploy ▶ (write)', kind: 'act', on: model.ops.deploy },
      { id: 'live', label: 'Live & monitored', kind: 'state', on: true },
      { id: 'drift', label: 'Drift detect ◀ (read)', kind: 'act', on: model.ops.drift },
      { id: 'correct', label: 'Correct (re-deploy)', kind: 'act', on: model.ops.deploy },
      { id: 'rollback', label: 'Roll back', kind: 'act', on: model.ops.rollback },
    ].filter((n) => n.on),
    edges: [
      ['author', 'validate', ''],
      ['validate', 'deploy', 'valid'],
      ['deploy', 'live', 'stored'],
      ['live', 'drift', 'sweep'],
      ['drift', 'live', 'in sync ✓'],
      ['drift', 'correct', 'drift found'],
      ['correct', 'live', ''],
      ['drift', 'rollback', 'revert'],
      ['rollback', 'live', ''],
      ['connect', 'deploy', 'enables'],
    ],
  }

  return { participants: P, operations, lifecycle }
}
