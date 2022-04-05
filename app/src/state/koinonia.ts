import { Action } from 'redux';
import { AllActions } from '.';


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
  data: object,
}

export const initialMessages: MessageSummary[] = [];

export interface KoinoniaState {
  messages: typeof initialMessages,
}

export const SET_MESSAGES = 'SET_MESSAGES';
export const UPDATE_MESSAGES = 'UPDATE_MESSAGES';
export const DELETE_MESSAGES = 'DELETE_MESSAGES';

export interface SetMessagesAction extends Action {
  type: typeof SET_MESSAGES | typeof UPDATE_MESSAGES,
  messages: MessageSummary[],
}
export interface DeleteMessagesAction extends Action {
  type: typeof DELETE_MESSAGES,
  messages: string[],
}

export type MessagesAction = SetMessagesAction | DeleteMessagesAction;

export function setMessages(messages: MessageSummary[]): SetMessagesAction {
  return {
    type: SET_MESSAGES,
    messages,
  };
}

export function updateMessages(
  messages: MessageSummary[],
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
    return action.messages.slice();
  } else if (action.type === UPDATE_MESSAGES) {
    const updatedIds = new Set(action.messages.map(message => message.message));
    const untouchedMessages = state.filter(message => !updatedIds.has(message.message));
    const unqiueMessages = action.messages.filter(
      (i1, index) => index === action.messages.findIndex(i2 => i2.message === i1.message),
    );
    return [...untouchedMessages, ...unqiueMessages];
  } else if (action.type === DELETE_MESSAGES) {
    const deletedIds = new Set(action.messages);
    return state.filter(message => !deletedIds.has(message.message));
  }

  return state;
}
