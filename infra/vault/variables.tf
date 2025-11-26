variable "environment" {
  type        = string
  description = "Deployment environment (e.g., dev, prod)"
}

variable "code_bucket" {
  type        = string
  description = "S3 bucket for storing Lambda deployment packages"
}

variable "full_domain" {
  type        = string
  description = "Full domain name for the application"
}
