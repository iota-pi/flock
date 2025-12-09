/// <reference path='./.sst/platform/config.d.ts' />

const PROD = 'production'

export default $config({
  app(input) {
    return {
      name: 'flock',
      removal: input?.stage === PROD ? 'retain' : 'remove',
      protect: [PROD].includes(input?.stage),
      home: 'aws',
      providers: {
        aws: {
          region: 'ap-southeast-2',
        },
        cloudflare: true,
      },
    }
  },
  async run() {
    const stage = $app.stage
    const isProd = stage === PROD

    const domain =
      isProd
        ? 'flock.cross-code.org'
        : `${stage}.flock.cross-code.org`
    const publicUrl = `https://${domain}`

    // -----------------------------------------------------------------
    // DynamoDB Tables
    // -----------------------------------------------------------------
    const accountsTable = new sst.aws.Dynamo('FlockAccounts', {
      // deletionProtection: true,
      fields: {
        account: 'string',
      },
      primaryIndex: { hashKey: 'account' },
      transform: {
        table: (args, opts) => {
          args.name = `FlockAccounts_${stage}`
        },
      },
    })

    const itemsTable = new sst.aws.Dynamo('FlockItems', {
      // deletionProtection: true,
      fields: {
        account: 'string',
        item: 'string',
      },
      primaryIndex: { hashKey: 'account', rangeKey: 'item' },
      transform: {
        table: (args, opts) => {
          args.name = `FlockItems_${stage}`
        },
      },
    })

    const subscriptionsTable = new sst.aws.Dynamo('FlockSubscriptions', {
      // deletionProtection: true,
      fields: {
        id: 'string',
        account: 'string',
      },
      primaryIndex: { hashKey: 'id', rangeKey: 'account' },
      transform: {
        table: (args, opts) => {
          args.name = `FlockSubscriptions_${stage}`
        },
      },
    })

    // -----------------------------------------------------------------
    // Vault API Lambda + Function URL
    // -----------------------------------------------------------------
    const vaultApi = new sst.aws.Function('VaultApi', {
      handler: 'src/vault/index.handler',
      runtime: 'nodejs22.x',
      memory: '512 MB',
      timeout: '5 seconds',
      url: {
        cors: false,
      },
      environment: {
        ACCOUNTS_TABLE: accountsTable.name,
        ITEMS_TABLE: itemsTable.name,
        SUBSCRIPTIONS_TABLE: subscriptionsTable.name,
      },
      link: [accountsTable, itemsTable, subscriptionsTable],
    })

    // -----------------------------------------------------------------
    // Migrations Lambda (invoked manually or via CI)
    // -----------------------------------------------------------------
    const migrationsLambda = new sst.aws.Function('VaultMigrations', {
      handler: 'src/vault/index.migrationHandler',
      runtime: 'nodejs22.x',
      memory: '512 MB',
      timeout: '60 seconds',
      environment: {
        ACCOUNTS_TABLE: accountsTable.name,
        ITEMS_TABLE: itemsTable.name,
        SUBSCRIPTIONS_TABLE: subscriptionsTable.name,
      },
      link: [accountsTable, itemsTable, subscriptionsTable],
    })


    // -----------------------------------------------------------------
    // Notifier Lambda (scheduled hourly)
    // -----------------------------------------------------------------
    new sst.aws.Cron('NotifierSchedule', {
      schedule: 'rate(1 hour)',
      job: {
        handler: 'src/vault/index.notifierHandler',
        runtime: 'nodejs22.x',
        memory: '512 MB',
        timeout: '60 seconds',
        environment: {
          ACCOUNTS_TABLE: accountsTable.name,
          ITEMS_TABLE: itemsTable.name,
          SUBSCRIPTIONS_TABLE: subscriptionsTable.name,
          PROD_APP_URL: publicUrl,
          GOOGLE_APPLICATION_CREDENTIALS: 'gcp-service-credentials.json',
        },
        link: [accountsTable, itemsTable, subscriptionsTable],
      },
    })

    // -----------------------------------------------------------------
    // AWS Backup for DynamoDB tables (prod only)
    // -----------------------------------------------------------------
    if (isProd) {
      const backupVault = new aws.backup.Vault(
        'FlockBackupVault',
        {
          name: `flock_dynamo_backup_vault_${stage}`,
        },
      )

      const backupPlan = new aws.backup.Plan(
        'FlockBackupPlan',
        {
          name: `flock_dynamo_backup_plan_${stage}`,
          rules: [
            {
              ruleName: `flock_dynamo_weekly_backup_plan_${stage}`,
              targetVaultName: backupVault.name,
              // Backup at ~2am (AEST) on Sunday morning each week (UTC)
              schedule: 'cron(0 4 ? * SAT *)',
              lifecycle: {
                deleteAfter: 30,
              },
            },
            {
              ruleName: `flock_dynamo_monthly_backup_${stage}`,
              targetVaultName: backupVault.name,
              // Backup at ~3am (AEST) on the 1st of each month (UTC)
              schedule: 'cron(0 5 1 * ? *)',
              lifecycle: {
                deleteAfter: 365,
              },
            },
          ],
        },
      )

      const backupRole = new aws.iam.Role(
        'FlockBackupRole',
        {
          name: `flock_dynamo_backup_role_${stage}`,
          assumeRolePolicy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Action: ['sts:AssumeRole'],
                Effect: 'Allow',
                Principal: {
                  Service: ['backup.amazonaws.com'],
                },
              },
            ],
          }),
        },
      )

      new aws.iam.RolePolicyAttachment(
        'FlockBackupPolicyAttachment',
        {
          policyArn:
            'arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup',
          role: backupRole.name,
        },
      )

      new aws.backup.Selection(
        'FlockBackupSelection',
        {
          iamRoleArn: backupRole.arn,
          name: `flock_dynamo_backup_selection_${stage}`,
          planId: backupPlan.id,
          resources: [accountsTable.arn, itemsTable.arn],
        },
      )
    }

    // -----------------------------------------------------------------
    // Frontend (Cloudflare Pages)
    // -----------------------------------------------------------------
    const app = new sst.cloudflare.StaticSite('FlockApp', {
      path: '.',
      build: {
        command: 'yarn build',
        output: 'dist/app',
      },
      domain,
      environment: {
        VITE_VAULT_ENDPOINT: vaultApi.url,
        VITE_PUBLIC_URL: publicUrl,
      },
    })

    return {
      appUrl: app.url,
      vaultEndpoint: vaultApi.url,
      migrationsLambda: migrationsLambda.name,
    }
  },
})
