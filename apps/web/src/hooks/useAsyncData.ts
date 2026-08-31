import { useCallback, useEffect, useRef, useState } from 'react';
import { readableErrorMessage } from '../lib/errors.js';

/**
 * 统一的「加载中 + 静默失败」数据加载模板：loading 置位 → fetch → 失败走 onError。
 * fetcher 用 ref 持有，reload 身份稳定，可以安全放进 useEffect 依赖。
 */
export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  options: { fallbackError?: string; onError?: (error: Error) => void } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  /** 首次 settle 后为 true；配合 data === null 区分「还没加载」与「加载失败」。 */
  const [loaded, setLoaded] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const fallbackErrorRef = useRef(options.fallbackError ?? '数据暂时无法读取');
  fallbackErrorRef.current = options.fallbackError ?? '数据暂时无法读取';
  const generationRef = useRef(0);

  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );

  const reload = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current();
      if (generation === generationRef.current) setData(result);
    } catch (cause) {
      if (generation === generationRef.current) {
        const message = readableErrorMessage(cause, fallbackErrorRef.current);
        const error = cause instanceof Error && !(cause instanceof TypeError) ? cause : new Error(message);
        setError(error);
        onErrorRef.current?.(error);
      }
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, []);

  return { data, setData, loading, loaded, error, reload };
}
