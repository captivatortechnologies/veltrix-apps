# =============================================================================
# AWS environment module — outputs.
#
# `resource_refs` is THE contract with the status-back path: a map of
# plan_key -> external cloud ref. The CI apply reads this (via `tofu output
# -json`) and/or the parsed apply stream and emits `resource.status
# {planKey, status, externalRef}` per key, which the app's onEvent hook maps
# onto the matching splunk_byol_resource row.
# =============================================================================

locals {
  # Foundation-tier refs, included only when the tier is in the plan.
  infra_refs = merge(
    { "foundation/network" = local.network_id },
    local.has_storage ? { "foundation/storage" = aws_s3_bucket.objstore[0].arn } : {},
    local.has_secrets ? { "foundation/secrets" = aws_secretsmanager_secret.env[0].arn } : {},
    local.has_license_file ? { "foundation/license-file" = aws_secretsmanager_secret.license[0].arn } : {},
    (local.dns_managed && local.has_tls && var.dns_domain != "") ? { "foundation/tls" = aws_acm_certificate.env[0].arn } : {},
    local.has_lb ? { "foundation/load-balancer" = aws_lb.env[0].arn } : {},
    local.dns_managed && local.has_dns && local.has_lb ? { "foundation/dns" = aws_route53_record.env[0].fqdn } : {},
    # HEC is realized as an endpoint on the LB (external) or on the standalone
    # instance; it maps to the LB ref when present. When there is no LB it is a
    # post-config step (reported via deployment.step, not a discrete resource).
    local.has_hec && local.has_lb ? { "ingest/hec" = aws_lb.env[0].dns_name } : {},
  )
}

output "resource_refs" {
  description = "Map of plan_key -> external cloud reference (instance id / arn / fqdn). Drives per-resource status-back."
  value = merge(
    { for k, inst in aws_instance.node : k => inst.id },
    local.infra_refs,
  )
}

output "subnet_id" {
  description = "Primary compute subnet id (the allocated subnet for shared/existing; the first private subnet for dedicated)."
  value       = local.compute_subnet_ids[0]
}

output "security_group_id" {
  description = "Id of the compute-node security group."
  value       = aws_security_group.splunk.id
}

output "network_id" {
  description = "Id of the network (VPC) this stack runs in — the created VPC for dedicated, the looked-up VPC for shared/existing."
  value       = local.network_id
}

output "vpc_id" {
  description = "Alias of network_id (AWS VPC id) for back-compat."
  value       = local.network_id
}

output "instance_ids" {
  description = "plan_key -> EC2 instance id for compute nodes."
  value       = { for k, inst in aws_instance.node : k => inst.id }
}

output "instance_private_ips" {
  description = "plan_key -> private IP for compute nodes."
  value       = { for k, inst in aws_instance.node : k => inst.private_ip }
}

output "node_fqdns" {
  description = <<-EOT
    plan_key -> function FQDN (e.g. idx1.<dns_domain>, sh1.<dns_domain>) for each
    compute node. The bring-up layer uses these to build its Splunk inventory
    (cluster/SHC peer resolution). Populated whenever dns_domain is set; the
    matching A records are only created when a private zone is present
    (create_private_zone or private_zone_id). Empty when dns_domain is unset.
  EOT
  value       = local.node_fqdns
}

output "vpc_cidr" {
  description = "CIDR of the VPC this stack runs in — the created VPC (dedicated) or the allocated subnet block otherwise. Used by the root to wire cross-region peering routes + peer security-group rules."
  value       = local.is_dedicated ? var.vpc_cidr : var.subnet_cidr
}

output "private_route_table_id" {
  description = "Id of the private (compute) route table for dedicated fabrics; empty otherwise. The root adds cross-region VPC-peering routes to it for multi-region satellites."
  value       = local.is_dedicated ? aws_route_table.private[0].id : ""
}

output "private_zone_id" {
  description = "Id of the private DNS zone (when dns_domain is set + a zone is created/supplied); empty otherwise. The root associates it with multi-region satellite VPCs so their nodes resolve the main region's function FQDNs."
  value       = local.want_private_dns ? local.private_zone_id : ""
}
