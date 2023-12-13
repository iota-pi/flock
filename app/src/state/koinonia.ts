import { createEntityAdapter, createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { Design } from 'react-email-editor';
import { Recipient } from '../../../koinonia/sender/types';
import { getItemName, MessageItem, PersonItem } from './items';

export interface MessageSummary {
  message: string,
  name: string,
  created: number,
}

export interface MessageContent {
  name: string,
  data: Design | null,
  sentTo: string[],
}

export interface MessageFull extends MessageSummary, MessageContent {}

const messagesAdapter = createEntityAdapter({
  selectId: (message: MessageFull) => message.message,
  sortComparer: (a, b) => b.created - a.created,
});

export const messagesSlice = createSlice({
  name: 'messages',
  initialState: messagesAdapter.getInitialState(),
  reducers: {
    setMessages(state, action: PayloadAction<MessageFull[]>) {
      messagesAdapter.setAll(state, action.payload);
    },
    updateMessages(state, action: PayloadAction<MessageFull[]>) {
      messagesAdapter.setMany(state, action.payload);
    },
    deleteMessages(state, payload: PayloadAction<string[]>) {
      messagesAdapter.removeMany(state, payload);
    },
  },
});

export const { setMessages, updateMessages, deleteMessages } = messagesSlice.actions;
export default messagesSlice.reducer;

// TODO: where should these utilities go? they don't really belong here
export function getRecipientFields(people: PersonItem[]): Recipient[] {
  return people.map(person => ({
    id: person.id,
    email: person.email,
    fields: {
      firstName: person.firstName,
      lastName: person.lastName,
      fullName: getItemName(person),
      email: person.email,
    },
  }));
}

export function getMessageItem(message: MessageSummary): MessageItem {
  return {
    type: 'message',
    id: message.message,
    name: message.name,
  };
}
