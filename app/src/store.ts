import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import { createStore, applyMiddleware } from 'redux';
import thunk, { ThunkMiddleware } from 'redux-thunk';
import { RootState, AllActions, rootReducer } from './state';

const store = createStore(
  rootReducer,
  applyMiddleware(thunk as ThunkMiddleware<RootState, AllActions>),
);

export default store;
export type AppDispatch = typeof store.dispatch;
export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
