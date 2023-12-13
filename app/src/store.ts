import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import { createStore } from 'redux';
import { devToolsEnhancer } from 'redux-devtools-extension';
import { RootState, rootReducer } from './state';

const store = createStore(
  rootReducer,
  devToolsEnhancer,
);

export default store;
export type AppDispatch = typeof store.dispatch;
export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
