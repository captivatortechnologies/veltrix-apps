# =============================================================================
# Hetzner Cloud environment module — provider/version pinning (OpenTofu HCL).
#
# OpenTofu resolves providers from registry.opentofu.org by default; the
# `hetznercloud/hcloud` source is mirrored there, so this block is compatible
# with both `tofu` and `terraform`. We pin OpenTofu >= 1.6.0 (the first stable
# OpenTofu line). No `random` provider is needed — Hetzner resource names are
# project-scoped (not globally unique like an S3 bucket), so the deterministic
# name_prefix (app_id + infrastructure_id) is sufficient for uniqueness.
#
# NOTE: Hetzner DNS is a SEPARATE product with a SEPARATE provider
# (`timohirt/hetznerdns`). It is deliberately NOT declared here — this module
# creates no DNS records (see the DNS gap note in main.tf). Per-node FQDNs are
# emitted as an output for the out-of-band bring-up layer to consume.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
  }
}
