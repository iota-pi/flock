import { Action } from 'redux';
import { AllActions } from '.';
import { Recipient } from '../../../../koinonia/sender/types';
import { getItemName, PersonItem } from './items';


export interface MessageKey {
  account: string,
  message: string,
}

export interface MessageSummary {
  message: string,
  name: string,
  created: number,
}

export interface MessageContent {
  name: string,
  data: { html?: string },
}

export interface MessageFull extends MessageSummary, MessageContent {}

export const initialMessages: MessageFull[] = [];

export interface KoinoniaState {
  messages: typeof initialMessages,
}

export const SET_MESSAGES = 'SET_MESSAGES';
export const UPDATE_MESSAGES = 'UPDATE_MESSAGES';
export const DELETE_MESSAGES = 'DELETE_MESSAGES';

export interface SetMessagesAction extends Action {
  type: typeof SET_MESSAGES | typeof UPDATE_MESSAGES,
  messages: MessageFull[],
}
export interface DeleteMessagesAction extends Action {
  type: typeof DELETE_MESSAGES,
  messages: string[],
}

export type MessagesAction = SetMessagesAction | DeleteMessagesAction;

export function setMessages(messages: MessageFull[]): SetMessagesAction {
  return {
    type: SET_MESSAGES,
    messages,
  };
}

export function updateMessages(
  messages: MessageFull[],
  dontUseThisDirectly: boolean,
): SetMessagesAction {
  if (dontUseThisDirectly !== true) {
    throw new Error('Don\'t use updateMessages directly! Use `KoinoniaAPI` instead');
  }
  return { type: UPDATE_MESSAGES, messages };
}

export function deleteMessages(
  messages: string[],
  dontUseThisDirectly: boolean,
): DeleteMessagesAction {
  if (dontUseThisDirectly !== true) {
    throw new Error('Don\'t use updateMessages directly! Use `KoinoniaAPI` instead');
  }
  return { type: DELETE_MESSAGES, messages };
}

export function messagesReducer(
  state: KoinoniaState['messages'] = initialMessages,
  action: MessagesAction | AllActions,
): KoinoniaState['messages'] {
  if (action.type === SET_MESSAGES) {
    return action.messages.slice().sort((a, b) => b.created - a.created);
  } else if (action.type === UPDATE_MESSAGES) {
    const updatedIds = new Set(action.messages.map(message => message.message));
    const untouchedMessages = state.filter(message => !updatedIds.has(message.message));
    const unqiueMessages = action.messages.filter(
      (i1, index) => index === action.messages.findIndex(i2 => i2.message === i1.message),
    );
    const newMessages = [...untouchedMessages, ...unqiueMessages];
    newMessages.sort((a, b) => b.created - a.created);
    return newMessages;
  } else if (action.type === DELETE_MESSAGES) {
    const deletedIds = new Set(action.messages);
    return state.filter(message => !deletedIds.has(message.message));
  }

  return state;
}

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
