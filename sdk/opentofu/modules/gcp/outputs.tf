# =============================================================================
# GCP environment module — outputs.
#
# `resource_refs` is THE contract with the status-back path: a map of
# plan_key -> external cloud ref (GCP self-link / id). The CI apply reads this
# (via `tofu output -json`) and/or the parsed apply stream and emits
# `resource.status {planKey, status, externalRef}` per key, which the app's
# onEvent hook maps onto the matching BYOL-resource row. Output NAMES are
# identical to sdk/opentofu/modules/aws.
# =============================================================================

locals {
  # Foundation-tier refs, included only when the tier is in the plan. Same
  # plan_key contract + `foundation/<x>` keys as AWS; values are GCP self-links /
  # ids (GCP LB/IP for the load-balancer + hec refs, in lieu of an ARN/DNS name).
  infra_refs = merge(
    { "foundation/network" = local.network_self_link },
    local.has_storage ? { "foundation/storage" = google_storage_bucket.objstore[0].url } : {},
    local.has_secrets ? { "foundation/secrets" = google_secret_manager_secret.env[0].id } : {},
    local.has_license_file ? { "foundation/license-file" = google_secret_manager_secret.license[0].id } : {},
    (local.dns_managed && local.has_tls && var.dns_domain != "") ? { "foundation/tls" = google_compute_managed_ssl_certificate.env[0].self_link } : {},
    local.has_lb ? { "foundation/load-balancer" = google_compute_global_address.lb[0].self_link } : {},
    local.dns_managed && local.has_dns && local.has_lb ? { "foundation/dns" = google_dns_record_set.env[0].name } : {},
    # HEC is realized as an endpoint on the LB (external) or on the standalone
    # instance; it maps to the LB's public IP when present. When there is no LB it
    # is a post-config step (reported via deployment.step, not a discrete resource).
    local.has_hec && local.has_lb ? { "ingest/hec" = google_compute_global_address.lb[0].address } : {},
  )
}

output "resource_refs" {
  description = "Map of plan_key -> external cloud reference (instance self-link / secret id / IP). Drives per-resource status-back."
  value = merge(
    { for k, inst in google_compute_instance.node : k => inst.self_link },
    local.infra_refs,
  )
}

output "subnet_id" {
  description = "Primary compute subnetwork self-link."
  value       = local.compute_subnet_ids[0]
}

output "security_group_id" {
  description = "The stack network tag — GCP's SG-to-SG identifier (applied to every instance and referenced by the firewall rules)."
  value       = local.stack_tag
}

output "network_id" {
  description = "Self-link of the network this stack runs in — the created network for dedicated, the looked-up network for shared/existing."
  value       = local.network_self_link
}

output "instance_ids" {
  description = "plan_key -> Compute Engine instance self-link for compute nodes."
  value       = { for k, inst in google_compute_instance.node : k => inst.self_link }
}

output "instance_private_ips" {
  description = "plan_key -> private IP for compute nodes."
  value       = { for k, inst in google_compute_instance.node : k => inst.network_interface[0].network_ip }
}

output "node_fqdns" {
  description = <<-EOT
    plan_key -> function FQDN (e.g. idx1.<dns_domain>, sh1.<dns_domain>) for each
    compute node. The bring-up layer uses these to build its inventory
    (cluster/SHC peer resolution). Populated whenever dns_domain is set; the
    matching A records are only created when a private zone is present
    (create_private_zone or private_zone_id). Empty when dns_domain is unset.
  EOT
  value       = local.node_fqdns
}
