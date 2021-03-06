output "environment" {
  value = local.environment
}

output "app_bucket" {
  value = module.app.app_bucket
}

output "vault_endpoint" {
  value = module.vault.invoke_url
}
