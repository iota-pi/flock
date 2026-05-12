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
        : `flock-${stage}.cross-code.org`
    const publicUrl = `https://${domain}`

    // -----------------------------------------------------------------
    // DynamoDB Tables
    // -----------------------------------------------------------------
    const accountsTable = new sst.aws.Dynamo('FlockAccounts', {
      deletionProtection: isProd,
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
      deletionProtection: isProd,
      fields: {
        account: 'string',
        item: 'string',
        modifiedAt: 'number',
      },
      primaryIndex: { hashKey: 'account', rangeKey: 'item' },
      globalIndexes: {
        AccountModifiedIndex: {
          hashKey: 'account',
          rangeKey: 'modifiedAt',
        },
      },
      transform: {
        table: (args, opts) => {
          args.name = `FlockItems_${stage}`
        },
      },
    })

    const syncMessagesTable = new sst.aws.Dynamo('FlockSyncMessages', {
      fields: {
        syncId: 'string',
        cursor: 'number',
      },
      primaryIndex: { hashKey: 'syncId', rangeKey: 'cursor' },
      transform: {
        table: args => {
          args.name = `FlockSyncMessages_${stage}`
          args.ttl = {
            attributeName: 'expiresAt',
            enabled: true,
          }
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
        SYNC_MESSAGES_TABLE: syncMessagesTable.name,
      },
      link: [
        accountsTable,
        itemsTable,
        syncMessagesTable,
      ],
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
        SYNC_MESSAGES_TABLE: syncMessagesTable.name,
      },
      link: [accountsTable, itemsTable, syncMessagesTable],
    })

    // -----------------------------------------------------------------
    // Push Notifications (Queue + Worker)
    // -----------------------------------------------------------------
    const vapidSubject = new sst.Secret('VAPID_SUBJECT')
    const vapidPublicKey = new sst.Secret('VAPID_PUBLIC_KEY')
    const vapidPrivateKey = new sst.Secret('VAPID_PRIVATE_KEY')

    const pushNotificationsDLQ = new sst.aws.Queue('PushNotificationsDLQ')

    const pushNotificationsQueue = new sst.aws.Queue('PushNotificationsQueue', {
      dlq: {
        queue: pushNotificationsDLQ.arn,
        retry: 3,
      },
    })

    pushNotificationsQueue.subscribe({
      handler: 'src/vault/notifier/worker.handler',
      runtime: 'nodejs22.x',
      memory: '512 MB',
      timeout: '60 seconds',
      environment: {
        ACCOUNTS_TABLE: accountsTable.name,
      },
      link: [
        accountsTable,
        vapidSubject,
        vapidPublicKey,
        vapidPrivateKey,
      ],
    })


    // -----------------------------------------------------------------
    // Reminder Enqueuer
    // -----------------------------------------------------------------
    new sst.aws.Cron('NotifierSchedule', {
      schedule: 'rate(15 minutes)',
      function: {
        handler: 'src/vault/notifier/enqueuer.handler',
        runtime: 'nodejs22.x',
        memory: '512 MB',
        timeout: '60 seconds',
        environment: {
          ACCOUNTS_TABLE: accountsTable.name,
          PUSH_NOTIFICATIONS_QUEUE_URL: pushNotificationsQueue.url,
        },
        link: [
          accountsTable,
          pushNotificationsQueue,
        ],
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
        VITE_VAPID_PUBLIC_KEY: vapidPublicKey.value,
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
