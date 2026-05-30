import type { FastifyRequest } from 'fastify'

import BaseDriver from './base'
import { HttpError } from '../api/errors'


class TestDriver extends BaseDriver {
  checkSessionMock = vi.fn()
  extendSessionMock = vi.fn()

  async init() {
    return this
  }

  connect() {
    return this
  }

  async createAccount() {
    return true
  }

  async checkSession(data: { account: string; session: string }) {
    return this.checkSessionMock(data)
  }

  async getAccount(): ReturnType<BaseDriver['getAccount']> {
    throw new Error('not implemented')
  }

  async getSecurityParams(): ReturnType<BaseDriver['getSecurityParams']> {
    throw new Error('not implemented')
  }

  async getNewAccountId(): ReturnType<BaseDriver['getNewAccountId']> {
    throw new Error('not implemented')
  }

  async updateAccountData() {
    throw new Error('not implemented')
  }

  async extendSession(data: { account: string }) {
    return this.extendSessionMock(data)
  }

  async fetchAll(): ReturnType<BaseDriver['fetchAll']> {
    throw new Error('not implemented')
  }

  async get(): ReturnType<BaseDriver['get']> {
    throw new Error('not implemented')
  }

  async set() {
    throw new Error('not implemented')
  }

  async delete() {
    throw new Error('not implemented')
  }
}

describe('BaseDriver auth', () => {
  it('throws when session is not valid', async () => {
    const driver = new TestDriver()
    driver.checkSessionMock.mockResolvedValue(null)

    const request = {
      params: { account: 'acc-1' },
      headers: { authorization: 'Bearer token-1' },
    } as unknown as FastifyRequest

    await expect(driver.auth(request)).rejects.toMatchObject({
      name: 'HttpError',
      statusCode: 403,
    } as HttpError)
    expect(driver.extendSessionMock).not.toHaveBeenCalled()
  })

  it('extends session when authentication succeeds', async () => {
    const driver = new TestDriver()
    driver.checkSessionMock.mockResolvedValue({ success: true })

    const request = {
      params: { account: 'acc-2' },
      headers: { authorization: 'Bearer token-2' },
    } as unknown as FastifyRequest

    await driver.auth(request)

    expect(driver.checkSessionMock).toHaveBeenCalledWith({
      account: 'acc-2',
      session: 'token-2',
    })
    expect(driver.extendSessionMock).toHaveBeenCalledWith({ account: 'acc-2' })
  })
})
