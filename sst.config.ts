/// <reference path='./.sst/platform/config.d.ts' />

export default $config({
  app(input) {
    return {
      name: 'flock',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: {
        aws: {
          region: 'ap-southeast-2',
        },
        cloudflare: true,
      },
    };
  },
  async run() {
    const stage = $app.stage === 'production' ? 'production' : $app.stage;

    const domain =
      $app.stage === 'production'
        ? 'flock.cross-code.org'
        : `${$app.stage}.flock.cross-code.org`;
    const publicUrl = `https://${domain}`;

    // -----------------------------------------------------------------
    // DynamoDB Tables
    // -----------------------------------------------------------------
    const accountsTable = new sst.aws.Dynamo('FlockAccounts', {
      fields: {
        account: 'string',
      },
      primaryIndex: { hashKey: 'account' },
      transform: {
        table: {
          name: `FlockAccounts_${stage}`,
        },
      },
    });

    const itemsTable = new sst.aws.Dynamo('FlockItems', {
      fields: {
        account: 'string',
        item: 'string',
      },
      primaryIndex: { hashKey: 'account', rangeKey: 'item' },
      transform: {
        table: {
          name: `FlockItems_${stage}`,
        },
      },
    });

    const subscriptionsTable = new sst.aws.Dynamo('FlockSubscriptions', {
      fields: {
        id: 'string',
        account: 'string',
      },
      primaryIndex: { hashKey: 'id', rangeKey: 'account' },
      transform: {
        table: {
          name: `FlockSubscriptions_${stage}`,
        },
      },
    });

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
    });

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
    });


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
    });

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
    });

    return {
      appUrl: app.url,
      vaultEndpoint: vaultApi.url,
      migrationsLambda: migrationsLambda.name,
    };
  },
});
