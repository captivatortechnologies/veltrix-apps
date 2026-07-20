# =============================================================================
# Hetzner Cloud environment module — outputs.
#
# `resource_refs` is THE contract with the status-back path: a map of
# plan_key -> external cloud ref. The CI apply reads this (via `tofu output
# -json`) and/or the parsed apply stream and emits `resource.status
# {planKey, status, externalRef}` per key, which the app's onEvent hook maps
# onto the matching BYOL-resource row. Output NAMES are identical to the
# AWS module; hcloud ids are numeric-in-state so they are tostring()'d to keep
# the ref map a uniform map(string).
# =============================================================================

locals {
  # Foundation-tier refs, included only when the tier is in the plan.
  #   * secrets / license-file: NO ref — Hetzner has no secret store (the values
  #     live in the platform vault; reported via deployment.step, not a resource).
  #   * dns: NO ref — Hetzner creates no DNS records (see gap notes in main.tf).
  #   * tls: the supplied hcloud certificate id (not created here) when present.
  #   * hec: maps to the LB's public IP when there is an LB (else a post-config
  #     step, exactly like the AWS module).
  infra_refs = merge(
    { "foundation/network" = tostring(local.network_id) },
    local.has_storage ? { "foundation/storage" = tostring(hcloud_volume.objstore[0].id) } : {},
    (local.has_tls && var.certificate_arn != "") ? { "foundation/tls" = var.certificate_arn } : {},
    local.has_lb ? { "foundation/load-balancer" = tostring(hcloud_load_balancer.env[0].id) } : {},
    local.has_hec && local.has_lb ? { "ingest/hec" = hcloud_load_balancer.env[0].ipv4 } : {},
  )
}

output "resource_refs" {
  description = "Map of plan_key -> external cloud reference (server id / volume id / cert id / LB id). Drives per-resource status-back."
  value = merge(
    { for k, s in hcloud_server.node : k => tostring(s.id) },
    local.infra_refs,
  )
}

output "subnet_id" {
  description = "Per-stack cloud subnet identifier. hcloud subnets have no standalone id, so this is the composite resource id (\"<network_id>-<ip_range>\")."
  value       = hcloud_network_subnet.env.id
}

output "security_group_id" {
  description = "Id of the compute-node firewall (the hcloud SG analog)."
  value       = tostring(hcloud_firewall.node.id)
}

output "network_id" {
  description = "Id of the hcloud_network this stack runs in — the created network for dedicated, the looked-up network for shared/existing."
  value       = tostring(local.network_id)
}

output "instance_ids" {
  description = "plan_key -> hcloud_server id for compute nodes."
  value       = { for k, s in hcloud_server.node : k => tostring(s.id) }
}

output "instance_private_ips" {
  description = "plan_key -> private IP (from the per-stack subnet attachment) for compute nodes."
  value       = { for k, n in hcloud_server_network.node : k => n.ip }
}

output "node_fqdns" {
  description = <<-EOT
    plan_key -> function FQDN (e.g. idx1.<dns_domain>, sh1.<dns_domain>) for each
    compute node. Derived identically to the AWS module. On Hetzner NO DNS record
    is created for these (the hcloud provider has no managed DNS); the bring-up
    layer consumes this map to build /etc/hosts or a hetznerdns stack out-of-band.
    Populated whenever dns_domain is set; empty otherwise.
  EOT
  value       = local.node_fqdns
}
