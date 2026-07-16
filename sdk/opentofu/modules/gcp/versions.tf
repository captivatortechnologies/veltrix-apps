# =============================================================================
# GCP environment module — provider/version pinning (OpenTofu-compatible HCL).
#
# OpenTofu resolves providers from registry.opentofu.org by default but the
# canonical `hashicorp/google` source address is mirrored there, so this block is
# byte-for-byte compatible with both `tofu` and `terraform`. We pin OpenTofu
# >= 1.6.0 (the first stable OpenTofu line) rather than a Terraform version.
#
# Provider: google ~> 6.0 (current major line). Every resource used here is in
# the GA `google` provider (no google-beta needed). random is used for the
# object-storage bucket suffix, exactly as in the AWS reference module.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
