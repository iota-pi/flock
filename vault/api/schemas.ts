const account = { type: 'string' }
const item = { type: 'string' }
const subscription = { type: 'string' }

export const accountParams = {
  type: 'object',
  properties: {
    account,
  },
  required: ['account'],
}

export const itemParams = {
  type: 'object',
  properties: {
    account,
    item,
  },
  required: ['account', 'item'],
}

export const subscriptionParams = {
  type: 'object',
  properties: {
    account,
    subscription,
  },
  required: ['account', 'subscription'],
}

export const itemBody = {
  type: 'object',
  properties: {
    cipher: { type: 'string' },
    iv: { type: 'string' },
    modified: { type: 'number' },
    type: { type: 'string' },
  },
  required: ['cipher', 'iv', 'modified', 'type'],
}

export const itemsBody = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      cipher: { type: 'string' },
      id: { type: 'string' },
      iv: { type: 'string' },
      modified: { type: 'number' },
      type: { type: 'string' },
    },
    required: ['cipher', 'id', 'iv', 'modified', 'type'],
  },
}

export const subscriptionBody = {
  type: 'object',
  properties: {
    failures: { type: 'number' },
    hours: { type: 'array', items: { type: 'number' } },
    timezone: { type: 'string' },
    token: { type: 'string' },
  },
  required: ['failures', 'hours', 'timezone', 'token'],
}
