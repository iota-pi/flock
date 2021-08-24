import { getItemId } from '../utils';
import { deleteItems, getBlankPerson } from './items';
import { DrawerData, drawersReducer, pushActive, removeActive, setUiState, UIData, replaceActive } from './ui';

describe('drawersReducer', () => {
  test('SET_UI_STATE', () => {
    const state: UIData['drawers'] = [];
    const newState: UIData['drawers'] = [
      {
        id: getItemId(),
        open: true,
        item: getItemId(),
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
      item: getItemId(),
    };
    const result = drawersReducer(state, replaceActive(drawer));
    expect(result.length).toEqual(1);
    expect(result[0]).toMatchObject(drawer);
  });

  test('REPLACE_ACTIVE (one item)', () => {
    const state: UIData['drawers'] = [{
      id: getItemId(),
      open: true,
      item: getItemId(),
    }];
    const drawer: Partial<Omit<DrawerData, 'id'>> = {
      open: false,
      report: true,
    };
    const result = drawersReducer(state, replaceActive(drawer));
    expect(result.length).toEqual(1);
    expect(result[0]).toMatchObject(drawer);
  });

  test('REPLACE_ACTIVE (multiple items)', () => {
    const state: UIData['drawers'] = [
      {
        id: getItemId(),
        open: true,
        item: getItemId(),
      },
      {
        id: getItemId(),
        open: true,
        item: getItemId(),
      },
    ];
    const drawer: Partial<Omit<DrawerData, 'id'>> = {
      open: false,
      report: true,
    };
    const result = drawersReducer(state, replaceActive(drawer));
    expect(result.slice(-1)[0]).toMatchObject(drawer);
  });

  test('PUSH_ACTIVE (empty)', () => {
    const state: UIData['drawers'] = [];
    const drawer: DrawerData = {
      id: getItemId(),
      open: true,
      item: getItemId(),
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
        item: getItemId(),
      },
    ];
    const drawer: DrawerData = {
      id: getItemId(),
      open: true,
      item: getItemId(),
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
        item: getItemId(),
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
        item: getItemId(),
      },
      {
        id: getItemId(),
        open: true,
        item: getItemId(),
      },
    ];
    const result = drawersReducer(state, removeActive());
    expect(result.length).toEqual(1);
  });

  test('DELETE_ITEMS', () => {
    const item1 = getBlankPerson();
    const item2 = getBlankPerson();
    const state: UIData['drawers'] = [
      {
        id: getItemId(),
        open: true,
        item: getItemId(),
        next: [getItemId(), item2.id, getItemId()],
      },
      {
        id: getItemId(),
        open: true,
        item: item1.id,
      },
    ];
    const result = drawersReducer(state, deleteItems([item1.id, item2.id], true));
    expect(result).toHaveLength(1);
    expect(result[0].next).toHaveLength(2);
    expect(result[0].next).not.toContainEqual(item2);
  });
});