import {
  deleteMessages,
  MessageContent,
  MessageSummary,
  MessageFull,
  setMessages,
  updateMessages,
} from '../state/koinonia';
import BaseAPI from './BaseAPI';


class KoinoniaAPI extends BaseAPI {
  readonly endpoint = process.env.REACT_APP_KOINONIA_ENDPOINT!;

  async listMessages(): Promise<MessageFull[]> {
    const url = `${this.endpoint}/${this.account}/messages`;
    const result = await this.wrap(this.axios.get(url));
    const messages: MessageFull[] = result.data.messages.map(
      (m: any) => ({ ...m, data: JSON.parse(m.data) }),
    );
    this.dispatch?.(setMessages(messages));
    return messages;
  }

  async createMessage({ name, data }: MessageContent): Promise<string> {
    const url = `${this.endpoint}/${this.account}/messages`;
    const result = await this.wrap(this.axios.post(url, {
      name,
      data: JSON.stringify(data),
    }));
    await this.getMessage({ message: result.data.messageId as string });
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
    this.dispatch?.(updateMessages([{ created, message, name, data }], true));
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
