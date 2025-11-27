output "environment" {
  value = local.environment
}

output "vault_endpoint" {
  value = module.vault.invoke_url
}
