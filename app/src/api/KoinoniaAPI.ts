import {
  deleteMessages,
  MessageContent,
  MessageSummary,
  MessageFull,
  setMessages,
  updateMessages,
} from '../state/koinonia';
import BaseAPI from './BaseAPI';
import { SendMailRequest } from '../../../../koinonia/sender/types';


class KoinoniaAPI extends BaseAPI {
  readonly endpoint = process.env.REACT_APP_KOINONIA_ENDPOINT!;

  async listMessages(): Promise<MessageFull[]> {
    const url = `${this.endpoint}/${this.account}/messages`;
    const result = await this.wrap(this.axios.get(url));
    const messages: MessageFull[] = result.data.messages;
    this.dispatch?.(setMessages(messages));
    return messages;
  }

  async createMessage({ name, data }: MessageContent): Promise<string> {
    const url = `${this.endpoint}/${this.account}/messages`;
    const result = await this.wrap(this.axios.post(url, { name, data }));
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
    await this.wrap(this.axios.patch(url, { name, data }));
  }

  async deleteMessage({ message }: Pick<MessageSummary, 'message'>): Promise<void> {
    const url = `${this.endpoint}/${this.account}/messages/${message}`;
    await this.wrap(this.axios.delete(url));
    this.dispatch?.(deleteMessages([message], true));
  }

  async sendMessage(
    {
      message,
      details,
    }: Pick<MessageSummary, 'message'> & { details: SendMailRequest },
  ): Promise<void> {
    const url = `${this.endpoint}/${this.account}/messages/${message}/send`;
    await this.wrapMany(
      details.recipients,
      recipientsChunk => this.axios.post(
        url,
        {
          ...details,
          recipients: recipientsChunk,
        } as SendMailRequest,
      ),
    );
  }

  getOpenCallbackURI(
    {
      message,
      recipient,
    }: Pick<MessageSummary, 'message'> & { recipient: string },
  ) {
    return `${this.endpoint}/o/${this.account}/${message}/${recipient}`;
  }
}

export default KoinoniaAPI;
