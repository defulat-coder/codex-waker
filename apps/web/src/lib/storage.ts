/** localStorage 的最小抽象：便于测试注入，隐私模式下降级为 undefined。 */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
