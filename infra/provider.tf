terraform {
  required_version = ">= 0.13"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
    }
  }

  backend "s3" {
    bucket         = "crosscode-terraform-state"
    key            = "flock/terraform.tfstate"
    region         = "ap-southeast-2"
    dynamodb_table = "CrossCodeTerraformLocking"
  }
}

provider "aws" {
  region = "ap-southeast-2"
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

provider "cloudflare" {
}
