# Splunk bring-up — Ansible layer

This layer turns freshly-provisioned VMs into a healthy, clustered Splunk
Enterprise deployment. It **drives** splunk-ansible (the `splunk.splunk`
collection roles) through ordered phases; it does **not** vendor them.

## How it is invoked

```bash
# 1. Install the roles/collections that site.yml drives.
ansible-galaxy collection install -r requirements.yml

# 2. Build the inventory from the topology plan + the tofu outputs.
node ../inventory/build-inventory.mjs \
  --plan       <stack>/terraform.tfvars.json \
  --tofu-output tofu-output.json \
  --out        inventory.yml \
  --health-out inventory.health.json \
  --region     us-east-1 \
  --dns-domain <tenant-domain>

# 3. Run the ordered bring-up.
ansible-playbook -i inventory.yml site.yml

# 4. Gate "ready" on Splunk's own health (separate script).
SPLUNK_ADMIN_USER=admin SPLUNK_ADMIN_PASSWORD=<from Secrets Manager> \
  node ../health/health-gate.mjs --cluster-manager-fqdn <cm> ...
```

The orchestrator `src/services/splunk/bringUp.ts` runs steps 2–4 as child
processes so the CI path and the programmatic path are one and the same.

## Ordering rationale (one PLAY per phase, top-to-bottom)

Each phase is gated on the previous one's splunkd being up. The sequence is not
cosmetic — it reflects Splunk's dependency graph:

1. **License Manager** first — every other node registers against it as a
   license slave on start; if it is not up they start unlicensed.
2. **Cluster Manager** — `[clustering] mode=manager`, RF=3 / SF=2, cluster
   `pass4SymmKey`. Must exist before any peer tries to join.
3. **Indexer peers** — `mode=peer`, `manager_uri` -> the CM, cluster
   `pass4SymmKey`; receive on 9997, replicate on 9887.
4. **Deployment Server** — forwarder management **only**. It must **never**
   manage search-head-cluster members (that corrupts the SHC); the deployer
   owns SHC apps.
5. **SHC members** start with `[shclustering]` + the SHC `pass4SymmKey`.
6. **Bootstrap the captain** on exactly one member (lowest ordinal). Bootstrap
   is a one-time, single-node action — never run on more than one member.
7. **Integrate** the SHC with the indexer cluster (each SH becomes a search
   peer of the CM) and **register the Deployer**.
8. **Deployer pushes** the SHC app bundle (`apply shcluster-bundle`).
9. **Heavy forwarders** — output to the indexer **cluster** via indexer
   discovery (ask the CM for the live peer list) rather than a static list.
10. **Monitoring Console** last, in distributed mode, with every node as a
    search peer so it observes the whole deployment.

Small-topology rules (applied by the inventory builder, surfaced as warnings):

- **< 3 indexers**: still a cluster, but RF=3 / SF=2 cannot be met until scaled
  — the health gate will report `replication_factor_met=0` until then.
- **< 3 search heads**: **no** SHC is formed. The hosts run as independent
  (standalone) search heads against the indexer cluster; phases 6–8 no-op
  (guarded on `splunk_shc_enabled`).

## Secrets / first-start ordering — READ THIS

- **`splunk.secret` must be placed BEFORE the first `splunkd` start** on every
  node (`tasks/pre_start_secrets.yml`, `0600 splunk:splunk`). splunkd uses it to
  encrypt `pass4SymmKey`/passwords on first start; if it is missing splunkd
  generates its own and **the cluster keys will not match across nodes**.
- **`pass4SymmKey` is written as CLEARTEXT and splunkd encrypts it on first
  start — after which it is unrecoverable from the node.** Therefore the
  cleartext keys are **retained in Secrets Manager** (per context) so new
  members can be added later with a matching key. One distinct key per context:
  `[general]`, `[clustering]`, `[shclustering]`, `[deployment]` — identical
  within a context, different across.
- **Admin is seeded HASHED** via `user-seed.conf` (`HASHED_PASSWORD` from
  `splunk hash-passwd`), never as plaintext argv/env. After first start,
  `force-change-pass=true` is armed on `admin` and the seed file is deleted
  (`tasks/post_start_admin.yml`). The plaintext admin password is used **only**
  for post-start REST auth and lives in Secrets Manager.
- Every task that touches secret material sets **`no_log: true`**. Do **not**
  run the play with `-vvv` in CI (that can echo templated vars).

## Internal TLS

Per-node AWS Private CA certs secure S2S (9997), mgmt (8089) and replication
(9887) with peer pinning (`sslVerifyServerCert=true`,
`sslVerifyServerName=true`). Cert paths are in `group_vars/all.yml`; the health
gate connects with `-k` (or `--ca <pem>` to pin) because the private CA is not
in the controller trust store.

## Controller IAM

The control node (CI runner) needs, for the tenant:
`secretsmanager:GetSecretValue` on the foundation/secrets ARN and `kms:Decrypt`
on the tenant CMK — the `aws_secret` lookup in `group_vars/all.yml` runs on the
controller.

## TEMPLATE status

This is a **template** for the BYOL infra repo (matching the `byol-apply.yml`
header). The role references and `SPLUNK_*` driving vars follow splunk-ansible's
documented interface; validate against the exact `splunk.splunk` collection
version you pin before going live.
