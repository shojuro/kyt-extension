import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withStorageMutex, _resetChains } from '../../src/utils/storage-mutex.js';

const store = {};

function clearStore() {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
}

global.chrome = {
  storage: {
    local: {
      get: vi.fn(async (keys) => {
        const result = {};
        for (const k of keys) {
          if (k in store) result[k] = structuredClone(store[k]);
        }
        return result;
      }),
      set: vi.fn(async (items) => {
        for (const [k, v] of Object.entries(items)) {
          store[k] = structuredClone(v);
        }
      }),
    },
  },
};

beforeEach(() => {
  clearStore();
  _resetChains();
  chrome.storage.local.get.mockClear();
  chrome.storage.local.set.mockClear();
});

describe('withStorageMutex', () => {
  it('sequential mutations: two concurrent calls on same key both apply', async () => {
    store.counter = { count: 0 };

    const p1 = withStorageMutex('counter', (current) => {
      current.count += 1;
      return current;
    });
    const p2 = withStorageMutex('counter', (current) => {
      current.count += 1;
      return current;
    });

    await Promise.all([p1, p2]);
    expect(store.counter.count).toBe(2);
  });

  it('different keys do not block each other', async () => {
    const order = [];

    const p1 = withStorageMutex('a', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('a-end');
      return { done: true };
    });
    const p2 = withStorageMutex('b', async () => {
      order.push('b-start');
      return { done: true };
    });

    await Promise.all([p1, p2]);
    // b should start before a ends since they're independent keys
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'));
  });

  it('default value used when key absent', async () => {
    let received;
    await withStorageMutex('missing', (current) => {
      received = current;
      return current;
    }, { initial: true });

    expect(received).toEqual({ initial: true });
  });

  it('mutator receives current value', async () => {
    store.data = { name: 'test', items: [1, 2, 3] };

    let received;
    await withStorageMutex('data', (current) => {
      received = current;
      return current;
    });

    expect(received).toEqual({ name: 'test', items: [1, 2, 3] });
  });

  it('undefined return skips write (read-only peek)', async () => {
    store.peek = { value: 42 };

    await withStorageMutex('peek', (current) => {
      // read but don't return
      return undefined;
    });

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(store.peek).toEqual({ value: 42 });
  });

  it('error in mutator does not break chain (next call still works)', async () => {
    store.resilient = { count: 0 };

    // First call throws
    await withStorageMutex('resilient', () => {
      throw new Error('boom');
    });

    // Second call should still work
    await withStorageMutex('resilient', (current) => {
      current.count += 1;
      return current;
    });

    expect(store.resilient.count).toBe(1);
  });

  it('rapid-fire 10 concurrent increments all apply (counter = 10)', async () => {
    store.rapid = { count: 0 };

    const promises = Array.from({ length: 10 }, () =>
      withStorageMutex('rapid', (current) => {
        current.count += 1;
        return current;
      })
    );

    await Promise.all(promises);
    expect(store.rapid.count).toBe(10);
  });

  it('_resetChains() clears pending chains', async () => {
    // Queue a call
    const p = withStorageMutex('x', (current) => {
      return { reset: true };
    });
    await p;

    _resetChains();

    // New call should work fresh (no stale chain)
    await withStorageMutex('x', (current) => {
      return { fresh: true };
    });

    expect(store.x).toEqual({ fresh: true });
  });

  it('default value function form called fresh each time', async () => {
    const factory = vi.fn(() => ({ count: 0 }));

    await withStorageMutex('fn1', (current) => {
      current.count = 5;
      return current;
    }, factory);

    // Delete so next call hits default again
    delete store.fn1;

    await withStorageMutex('fn1', (current) => {
      current.count = 10;
      return current;
    }, factory);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(store.fn1.count).toBe(10);
  });

  it('mutator can be async', async () => {
    store.async_key = { value: 1 };

    await withStorageMutex('async_key', async (current) => {
      await new Promise((r) => setTimeout(r, 5));
      current.value *= 3;
      return current;
    });

    expect(store.async_key.value).toBe(3);
  });

  it('works with arrays (push pattern)', async () => {
    store.log = ['first'];

    await withStorageMutex('log', (current) => {
      current.push('second');
      return current;
    }, []);

    await withStorageMutex('log', (current) => {
      current.push('third');
      return current;
    }, []);

    expect(store.log).toEqual(['first', 'second', 'third']);
  });

  it('works with nested objects', async () => {
    store.nested = { a: { b: { c: 1 } } };

    await withStorageMutex('nested', (current) => {
      current.a.b.c += 1;
      current.a.b.d = 'new';
      return current;
    });

    expect(store.nested).toEqual({ a: { b: { c: 2, d: 'new' } } });
  });
});
