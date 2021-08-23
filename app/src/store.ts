import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import { applyMiddleware, compose, createStore } from 'redux';
import thunk, { ThunkMiddleware } from 'redux-thunk';
import { composeWithDevTools } from 'redux-devtools-extension';
import { RootState, AllActions, rootReducer } from './state';

const aptCompose: typeof composeWithDevTools = (
  process.env.NODE_ENV === 'production' ? compose : composeWithDevTools
);
const store = createStore(
  rootReducer,
  aptCompose(
    applyMiddleware(thunk as ThunkMiddleware<RootState, AllActions>),
  ),
);

export default store;
export type AppDispatch = typeof store.dispatch;
export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
