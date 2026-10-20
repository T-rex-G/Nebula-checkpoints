/*
 * Every value through an asynchronous operation, at most `limit` at a time,
 * the answers in the values' own order. The workers share one iterator, so
 * each value is taken exactly once whichever worker is free first.
 */
export async function boundedMap<T, R>(values: readonly T[], limit: number, operation: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  const pending = values.entries();
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (const [index, value] of pending) results[index] = await operation(value, index);
  }));
  return results;
}
