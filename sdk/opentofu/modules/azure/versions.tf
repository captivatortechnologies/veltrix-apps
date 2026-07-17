# =============================================================================
# Azure environment module — provider/version pinning (OpenTofu-compatible HCL).
#
# OpenTofu resolves providers from registry.opentofu.org by default but the
# canonical `hashicorp/azurerm` source address is mirrored there, so this block
# is byte-for-byte compatible with both `tofu` and `terraform`. We pin OpenTofu
# >= 1.6.0 (the first stable OpenTofu line) rather than a Terraform version.
#
# NOTE: this module declares NO `provider "azurerm"` block — the platform
# render+apply worker configures the provider (subscription_id, features {}, and
# the customer credential for BYOC) at the root, and the module inherits it.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
