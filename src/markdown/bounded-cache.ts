/** A bounded key→value cache with insertion-order (FIFO) eviction: once `max`
 *  entries are held, inserting a new key drops the oldest-inserted one. Used by
 *  the render widgets (mermaid SVGs, katex HTML) so reveal/unreveal cycles and
 *  scrolling never re-run a renderer, without the cache growing unbounded.
 *
 *  Eviction matches the previous hand-rolled copies exactly: the size guard runs
 *  before every `set`, so it relies on Map preserving insertion order. */
export interface BoundedCache<K, V> {
  get(key: K): V | undefined;
  put(key: K, value: V): void;
  clear(): void;
  readonly size: number;
}

export function boundedCache<K, V>(max: number): BoundedCache<K, V> {
  const map = new Map<K, V>();
  return {
    get: (key) => map.get(key),
    put(key, value) {
      if (map.size >= max) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, value);
    },
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}
