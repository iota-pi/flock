import {
  deleteMessages,
  MessageContent,
  MessageSummary,
  MessageFull,
  setMessages,
  updateMessages,
} from '../state/koinonia';
import BaseAPI from './BaseAPI';
import { SendMailRequest, TrackingItem } from '../../../../koinonia/sender/types';


export type SendProgressCallback = (data: {
  success: boolean,
  successCount: number,
  errorCount: number,
}) => void;


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

  async saveMessage(messageData: MessageFull): Promise<void> {
    const { created, data, message, name, sentTo } = messageData;
    const url = `${this.endpoint}/${this.account}/messages/${message}`;
    this.dispatch?.(updateMessages([
      { created, message, name, data, sentTo },
    ], true));
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
      progressCallback,
    }: Pick<MessageSummary, 'message'> & {
      details: SendMailRequest,
      progressCallback?: SendProgressCallback,
    },
  ): Promise<void> {
    const url = `${this.endpoint}/${this.account}/messages/${message}/send`;
    await this.wrapMany(
      details.recipients,
      async recipientsChunk => {
        const response = await this.axios.post(
          url,
          {
            ...details,
            recipients: recipientsChunk,
          } as SendMailRequest,
        );
        progressCallback?.(response.data);
        return response;
      },
    );
  }

  async getStats({ message }: Pick<MessageSummary, 'message'>) {
    const url = `${this.endpoint}/${this.account}/messages/${message}/stats`;
    const results = await this.wrap(this.axios.get(url));
    if (results.data.success) {
      return results.data.stats as TrackingItem;
    }
    return undefined;
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
