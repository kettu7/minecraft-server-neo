import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage, deleteStorage, listStorages, setOrder } from '../src/db.ts';

const input = (name: string) => ({ name, x: 0, y: 64, z: 0, radius: 1, height: 1, dimension: 'minecraft:overworld' as const, includeShulkers: true });

test('Reihenfolge der Lager: gespeicherte Position zählt, neue stehen vorn', () => {
  const a = createStorage(input('Test A'));
  const b = createStorage(input('Test B'));
  const c = createStorage(input('Test C'));
  try {
    setOrder('storages', [c, a, b]);
    const ours = () => listStorages().map((s) => (s as unknown as { id: number }).id).filter((id) => [a, b, c].includes(id));
    assert.deepEqual(ours(), [c, a, b]);

    const d = createStorage(input('Test D'));
    try {
      const ids = listStorages().map((s) => (s as unknown as { id: number }).id);
      assert.ok(ids.indexOf(d) < ids.indexOf(c), 'neues Lager steht vor den einsortierten');
    } finally {
      deleteStorage(d);
    }
  } finally {
    [a, b, c].forEach(deleteStorage);
  }
});
