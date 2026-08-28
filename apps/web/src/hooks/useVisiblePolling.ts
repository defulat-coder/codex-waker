import { useEffect, useRef } from 'react';

/**
 * 页面可见时的固定间隔轮询：每个 tick 检查 document.visibilityState，
 * 隐藏页签不发起请求；卸载时清理 timer。callback 用 ref 持有，hook 身份稳定。
 */
export function useVisiblePolling(callback: () => void, intervalMs: number) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') callbackRef.current();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}
