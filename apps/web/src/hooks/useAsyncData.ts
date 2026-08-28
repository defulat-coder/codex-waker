import { useCallback, useRef, useState } from 'react';

/**
 * 统一的「加载中 + 静默失败」数据加载模板：loading 置位 → fetch → 失败走 onError。
 * fetcher 用 ref 持有，reload 身份稳定，可以安全放进 useEffect 依赖。
 */
export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  options: { onError?: (error: Error) => void } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  /** 首次 settle 后为 true；配合 data === null 区分「还没加载」与「加载失败」。 */
  const [loaded, setLoaded] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetcherRef.current());
    } catch (cause) {
      onErrorRef.current?.(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  return { data, setData, loading, loaded, reload };
}
