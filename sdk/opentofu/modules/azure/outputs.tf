# =============================================================================
# Azure environment module — outputs.
#
# `resource_refs` is THE contract with the status-back path: a map of
# plan_key -> external cloud ref. The CI apply reads this (via `tofu output
# -json`) and/or the parsed apply stream and emits `resource.status
# {planKey, status, externalRef}` per key, which the app's onEvent hook maps
# onto the matching BYOL resource row. Names are IDENTICAL to the AWS module.
# =============================================================================

locals {
  # Foundation-tier refs, included only when the tier is in the plan. Mirrors the
  # AWS infra_refs map key-for-key (Azure resource ids in place of AWS arns).
  infra_refs = merge(
    { "foundation/network" = local.network_id },
    local.has_storage ? { "foundation/storage" = azurerm_storage_account.objstore[0].id } : {},
    local.has_secrets ? { "foundation/secrets" = azurerm_key_vault.secrets[0].id } : {},
    local.has_license_file ? { "foundation/license-file" = azurerm_key_vault_secret.license[0].id } : {},
    # TLS: Azure has no in-module cert issuance, so the ref is the caller-supplied
    # Key Vault cert id (var.certificate_arn) when a tls tier is planned.
    (local.has_tls && var.certificate_arn != "") ? { "foundation/tls" = var.certificate_arn } : {},
    local.has_lb_spec ? { "foundation/load-balancer" = azurerm_application_gateway.env[0].id } : {},
    (local.dns_managed && local.has_dns && local.has_lb_spec) ? { "foundation/dns" = azurerm_dns_a_record.env[0].fqdn } : {},
    # HEC maps to the front-door public IP when present. When there is no LB it is
    # a post-config step (reported via deployment.step, not a discrete resource).
    (local.has_hec && local.has_lb_spec) ? { "ingest/hec" = azurerm_public_ip.appgw[0].ip_address } : {},
  )
}

output "resource_refs" {
  description = "Map of plan_key -> external cloud reference (VM id / resource id / fqdn). Drives per-resource status-back."
  value = merge(
    { for k, vm in azurerm_linux_virtual_machine.node : k => vm.id },
    local.infra_refs,
  )
}

output "subnet_id" {
  description = "Primary compute subnet id (the allocated subnet for shared/existing; the private subnet for dedicated)."
  value       = local.compute_subnet_ids[0]
}

output "security_group_id" {
  description = "Id of the compute-node network security group (NSG)."
  value       = azurerm_network_security_group.node.id
}

output "network_id" {
  description = "Id of the network (VNet) this stack runs in — the created VNet for dedicated, the looked-up VNet for shared/existing."
  value       = local.network_id
}

output "instance_ids" {
  description = "plan_key -> VM id for compute nodes."
  value       = { for k, vm in azurerm_linux_virtual_machine.node : k => vm.id }
}

output "instance_private_ips" {
  description = "plan_key -> private IP for compute nodes."
  value       = { for k, nic in azurerm_network_interface.node : k => nic.private_ip_address }
}

output "node_fqdns" {
  description = <<-EOT
    plan_key -> function FQDN (e.g. idx1.<dns_domain>, sh1.<dns_domain>) for each
    compute node. The bring-up layer uses these to build its inventory (cluster
    peer resolution). Populated whenever dns_domain is set; the matching A records
    are only created when a private zone is present (create_private_zone or
    private_zone_id). Empty when dns_domain is unset.
  EOT
  value       = local.node_fqdns
}
