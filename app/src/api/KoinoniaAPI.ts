import {
  deleteMessages,
  MessageContent,
  MessageSummary,
  MessageFull,
  setMessages,
  updateMessages,
} from '../state/messages';
import { getAxios, wrapManyRequests, wrapRequest } from './common';
import env from '../env';
import { SendMailRequest, TrackingItem } from '../../../koinonia/sender/types';
import store from '../store';
import { generateAccountId } from '../utils';

const ENDPOINT = env.KOINONIA_ENDPOINT;

export type SendProgressCallback = (data: {
  success: boolean,
  successCount: number,
  errorCount: number,
}) => void;


export async function listMessages(): Promise<MessageFull[]> {
  const url = `${ENDPOINT}/${generateAccountId()}/messages`;
  const result = await wrapRequest(getAxios().get(url));
  const messages: MessageFull[] = result.data.messages;
  store.dispatch(setMessages(messages));
  return messages;
}

export async function createMessage({ name, data }: MessageContent): Promise<string> {
  const url = `${ENDPOINT}/${generateAccountId()}/messages`;
  const result = await wrapRequest(getAxios().post(url, { name, data }));
  await getMessage({ message: result.data.messageId as string });
  return result.data.messageId;
}

export async function getMessage({ message }: Pick<MessageSummary, 'message'>): Promise<MessageSummary> {
  const url = `${ENDPOINT}/${generateAccountId()}/messages/${message}`;
  const result = await wrapRequest(getAxios().get(url));
  store.dispatch(updateMessages([result.data.message]));
  return result.data.message as MessageSummary;
}

export async function saveMessage(messageData: MessageFull): Promise<void> {
  const { created, data, message, name, sentTo } = messageData;
  const url = `${ENDPOINT}/${generateAccountId()}/messages/${message}`;
  store.dispatch(updateMessages([
    { created, message, name, data, sentTo },
  ]));
  await wrapRequest(getAxios().patch(url, { name, data }));
}

export async function deleteMessage({ message }: Pick<MessageSummary, 'message'>): Promise<void> {
  const url = `${ENDPOINT}/${generateAccountId()}/messages/${message}`;
  await wrapRequest(getAxios().delete(url));
  store.dispatch(deleteMessages([message]));
}

export async function sendMessage(
  {
    message,
    details,
    progressCallback,
  }: Pick<MessageSummary, 'message'> & {
    details: SendMailRequest,
    progressCallback?: SendProgressCallback,
  },
): Promise<void> {
  const url = `${ENDPOINT}/${generateAccountId()}/messages/${message}/send`;
  await wrapManyRequests(
    details.recipients,
    async recipientsChunk => {
      const response = await getAxios().post(
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

export async function getStats({ message }: Pick<MessageSummary, 'message'>) {
  const url = `${ENDPOINT}/${generateAccountId()}/messages/${message}/stats`;
  const results = await wrapRequest(getAxios().get(url));
  if (results.data.success) {
    return results.data.stats as TrackingItem;
  }
  return undefined;
}

export function getOpenCallbackURI(
  {
    message,
    recipient,
  }: Pick<MessageSummary, 'message'> & { recipient: string },
) {
  return `${ENDPOINT}/o/${generateAccountId()}/${message}/${recipient}`;
}
