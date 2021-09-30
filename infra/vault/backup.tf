resource "aws_backup_vault" "backup_vault" {
  name = "flock_dynamo_backup_vault_${var.environment}"
}

resource "aws_backup_plan" "dynamo_backup" {
  name = "flock_dynamo_backup_plan_${var.environment}"

  rule {
    rule_name = "flock_dynamo_weekly_backup_plan_${var.environment}"
    target_vault_name = aws_backup_vault.backup_vault.name
    // Backup at ~2am (AEST) on Sunday morning each week
    // NB: time in UTC
    schedule = "cron(0 4 ? * SAT *)"

    lifecycle {
      delete_after = 30
    }
  }

  rule {
    rule_name = "flock_dynamo_daily_backup_plan_${var.environment}"
    target_vault_name = aws_backup_vault.backup_vault.name
    // Backup at ~4am (AEST) each day
    // NB: time in UTC
    schedule = "cron(0 6 ? * * *)"

    lifecycle {
      delete_after = 7
    }
  }
}

resource "aws_backup_selection" "dynamo_backup_selection" {
  iam_role_arn = aws_iam_role.dynamo_backup_role.arn
  name = "flock_dynamo_backup_selection_${var.environment}"
  plan_id = aws_backup_plan.dynamo_backup.id

  resources = [
    aws_dynamodb_table.vault_accounts_table.arn,
    aws_dynamodb_table.vault_items_table.arn,
  ]
}

resource "aws_iam_role" "dynamo_backup_role" {
  name               = "flock_dynamo_backup_role_${var.environment}"
  assume_role_policy = <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": ["sts:AssumeRole"],
      "Effect": "allow",
      "Principal": {
        "Service": ["backup.amazonaws.com"]
      }
    }
  ]
}
POLICY
}

resource "aws_iam_role_policy_attachment" "dynamo_backup_policy" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
  role       = aws_iam_role.dynamo_backup_role.name
}

