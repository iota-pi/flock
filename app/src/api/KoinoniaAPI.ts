import { deleteMessages, MessageContent, MessageSummary, setMessages, updateMessages } from '../state/koinonia';
import BaseAPI from './BaseAPI';


class KoinoniaAPI extends BaseAPI {
  readonly endpoint = process.env.REACT_APP_KOINONIA_ENDPOINT!;

  async listMessages(): Promise<MessageSummary[]> {
    const url = `${this.endpoint}/${this.account}/messages`;
    const result = await this.wrap(this.axios.get(url));
    this.dispatch?.(setMessages(result.data.messages));
    return result.data.messages;
  }

  async createMessage({ name, data }: MessageContent): Promise<string> {
    const url = `${this.endpoint}/${this.account}/messages`;
    const result = await this.wrap(this.axios.post(url, {
      name,
      data: JSON.stringify(data),
    }));
    await this.getMessage(result.data.messageId);
    return result.data.messageId;
  }

  async getMessage({ message }: Pick<MessageSummary, 'message'>): Promise<MessageSummary> {
    const url = `${this.endpoint}/${this.account}/messages/${message}`;
    const result = await this.wrap(this.axios.get(url));
    this.dispatch?.(updateMessages([result.data.message], true));
    return result.data.message as MessageSummary;
  }

  async saveMessage(messageData: MessageSummary & MessageContent): Promise<void> {
    const { created, data, message, name } = messageData;
    const url = `${this.endpoint}/${this.account}/messages/${message}`;
    this.dispatch?.(updateMessages([{ created, message, name }], true));
    await this.wrap(this.axios.patch(url, {
      name,
      data: JSON.stringify(data),
    }));
  }

  async deleteMessage({ message }: Pick<MessageSummary, 'message'>): Promise<void> {
    const url = `${this.endpoint}/${this.account}/messages/${message}`;
    await this.wrap(this.axios.delete(url));
    this.dispatch?.(deleteMessages([message], true));
  }
}

export default KoinoniaAPI;
