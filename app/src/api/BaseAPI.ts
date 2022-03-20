import axios, { AxiosRequestConfig } from 'axios';
import { finishRequest, setMessage, startRequest } from '../state/ui';
import { AppDispatch } from '../store';


abstract class BaseAPI {
  abstract readonly endpoint: string;
  protected readonly account: string;
  private readonly authToken: string | undefined;
  dispatch: AppDispatch | undefined;

  constructor(account: string, authToken?: string, dispatch?: AppDispatch) {
    this.account = account;
    this.authToken = authToken;
    this.dispatch = dispatch;
  }

  private startRequest() {
    if (this.dispatch) {
      this.dispatch(startRequest());
    }
  }

  private finishRequest(error?: string) {
    if (this.dispatch) {
      this.dispatch(finishRequest());
      if (error) {
        this.dispatch(setMessage({
          message: error,
          severity: 'error',
        }));
      }
    }
  }

  protected async wrap<T>(promise: Promise<T>): Promise<T> {
    this.startRequest();
    try {
      const result = await promise;
      this.finishRequest();
      return result;
    } catch (error) {
      this.finishRequest('A request to the server failed. Please retry later.');
      throw error;
    }
  }

  protected async wrapMany<T, S>(
    data: T[],
    requestFunc: (data: T[]) => Promise<S>,
    chunkSize = 10,
  ): Promise<S[]> {
    this.startRequest();
    try {
      const workingData = data.slice();
      const result: S[] = [];
      while (workingData.length > 0) {
        const batch = workingData.splice(0, chunkSize);
        // eslint-disable-next-line no-await-in-loop
        const batchResult = await requestFunc(batch);
        result.push(batchResult);
      }
      this.finishRequest();
      return result;
    } catch (error) {
      this.finishRequest('A request to the server failed. Please retry later.');
      throw error;
    }
  }

  private getAuth(): AxiosRequestConfig {
    if (this.authToken) {
      return {
        headers: { Authorization: `Basic ${this.authToken}` },
      };
    }
    return {};
  }

  protected get axios() {
    return axios.create({
      ...this.getAuth(),
    });
  }
}

export default BaseAPI;
