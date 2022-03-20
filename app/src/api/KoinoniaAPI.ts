import BaseAPI from './BaseAPI';


export interface MessageKey {
  account: string,
  message: string,
}

export interface MessageSummary {
  message: string,
  name: string,
}

export interface MessageContent {
  name: string,
  data: object,
}

class KoinoniaAPI extends BaseAPI {
  readonly endpoint = process.env.REACT_APP_KOINONIA_ENDPOINT!;

  async listMessages(): Promise<MessageSummary[]> {
    const url = `${this.endpoint}/${this.account}/messages`;
    const result = await this.wrap(this.axios.get(url));
    return result.data.messages;
  }

  async createMessage({ name, data }: MessageContent): Promise<string> {
    const url = `${this.endpoint}/${this.account}/messages`;
    const result = await this.wrap(this.axios.post(url, {
      name,
      data: JSON.stringify(data),
    }));
    return result.data.messageId;
  }

  async saveMessage({ message, name, data }: MessageSummary & MessageContent): Promise<void> {
    const url = `${this.endpoint}/${this.account}/messages/${message}`;
    await this.wrap(this.axios.patch(url, {
      name,
      data: JSON.stringify(data),
    }));
  }
}

export default KoinoniaAPI;
