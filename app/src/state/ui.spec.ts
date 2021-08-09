import { getItemId } from '../utils';
import { getBlankPerson } from './items';
import { DrawerData, drawersReducer, pushActive, removeActive, setUiState, UIData, updateActive } from './ui';

describe('drawersReducer', () => {
  test('SET_UI_STATE', () => {
    const state: UIData['drawers'] = [];
    const newState: UIData['drawers'] = [
      {
        id: getItemId(),
        open: true,
        item: getBlankPerson(),
      },
    ];
    const result = drawersReducer(state, setUiState({ drawers: newState }));
    expect(result).toEqual(newState);
  });

  test('REPLACE_ACTIVE (empty)', () => {
    const state: UIData['drawers'] = [];
    const drawer: DrawerData = {
      id: getItemId(),
      open: true,
      item: getBlankPerson(),
    };
    const result = drawersReducer(state, updateActive(drawer));
    expect(result.length).toEqual(1);
    expect(result[0]).toMatchObject(drawer);
  });

  test('REPLACE_ACTIVE (one item)', () => {
    const state: UIData['drawers'] = [{
      id: getItemId(),
      open: true,
      item: getBlankPerson(),
    }];
    const drawer: Partial<Omit<DrawerData, 'id'>> = {
      open: false,
      report: true,
    };
    const result = drawersReducer(state, updateActive(drawer));
    expect(result.length).toEqual(1);
    expect(result[0]).toMatchObject(drawer);
  });

  test('REPLACE_ACTIVE (multiple items)', () => {
    const state: UIData['drawers'] = [
      {
        id: getItemId(),
        open: true,
        item: getBlankPerson(),
      },
      {
        id: getItemId(),
        open: true,
        item: getBlankPerson(),
      },
    ];
    const drawer: Partial<Omit<DrawerData, 'id'>> = {
      open: false,
      report: true,
    };
    const result = drawersReducer(state, updateActive(drawer));
    expect(result.slice(-1)[0]).toMatchObject(drawer);
  });

  test('PUSH_ACTIVE (empty)', () => {
    const state: UIData['drawers'] = [];
    const drawer: DrawerData = {
      id: getItemId(),
      open: true,
      item: getBlankPerson(),
    };
    const result = drawersReducer(state, pushActive(drawer));
    expect(result.length).toEqual(1);
    expect(result[0]).toMatchObject(drawer);
  });

  test('PUSH_ACTIVE (non-empty)', () => {
    const state: UIData['drawers'] = [
      {
        id: getItemId(),
        open: true,
        item: getBlankPerson(),
      },
    ];
    const drawer: DrawerData = {
      id: getItemId(),
      open: true,
      item: getBlankPerson(),
    };
    const result = drawersReducer(state, pushActive(drawer));
    expect(result.length).toEqual(2);
    expect(result[0]).not.toMatchObject(drawer);
    expect(result[1]).toMatchObject(drawer);
  });

  test('REMOVE_ACTIVE (empty)', () => {
    const state: UIData['drawers'] = [];
    const result = drawersReducer(state, removeActive());
    expect(result.length).toEqual(0);
  });

  test('REMOVE_ACTIVE (one item)', () => {
    const state: UIData['drawers'] = [
      {
        id: getItemId(),
        open: true,
        item: getBlankPerson(),
      },
    ];
    const result = drawersReducer(state, removeActive());
    expect(result.length).toEqual(0);
  });

  test('REMOVE_ACTIVE (multiple)', () => {
    const state: UIData['drawers'] = [
      {
        id: getItemId(),
        open: true,
        item: getBlankPerson(),
      },
      {
        id: getItemId(),
        open: true,
        item: getBlankPerson(),
      },
    ];
    const result = drawersReducer(state, removeActive());
    expect(result.length).toEqual(1);
  });

  test('UPDATE_ITEMS', () => {

  });

  test('DELETE_ITEMS', () => {

  });
});