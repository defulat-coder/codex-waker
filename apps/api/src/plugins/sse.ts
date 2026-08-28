import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseConnection<TEvent extends { type: string }> {
  /** Writes one named SSE frame; silently drops once the client is gone. */
  send(event: TEvent): void;
  /** Marks the stream finished, stops the heartbeat, and ends the response. */
  close(): void;
  readonly closed: boolean;
  /** Fires when the client disconnects before close(); use it to abort upstream work. */
  onDisconnect(callback: () => void): void;
}

/**
 * Hijacks the reply as an SSE stream with a comment-frame heartbeat so long
 * thinking turns survive proxies. 客户端断连监听 response 的 'close'
 * （request 的 'close' 在 Node 18+ 表示请求体读完，不是断连）。
 */
export function startSse<TEvent extends { type: string }>(
  request: FastifyRequest,
  reply: FastifyReply,
): SseConnection<TEvent> {
  const raw = reply.raw;
  reply.hijack();
  raw.statusCode = 200;
  raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  raw.setHeader('Cache-Control', 'no-cache, no-transform');
  raw.setHeader('Connection', 'keep-alive');
  raw.setHeader('X-Accel-Buffering', 'no');
  raw.flushHeaders?.();

  let closed = false;
  let finished = false;
  const disconnectCallbacks: (() => void)[] = [];

  const heartbeat = setInterval(() => {
    if (closed || raw.writableEnded || raw.destroyed) return;
    try {
      raw.write(': ping\n\n');
    } catch {
      closed = true;
    }
  }, 15000);

  // 监听 response（而非 request）的 close：Node 18+ 里 request.raw 在请求体被
  // fastify 消费完就会触发 'close'，不能用作客户端断连信号；response 的 close 只在
  // 底层连接终止时触发（raw.end() 后 finished=true 走守卫，客户端断开才置 closed）。
  raw.once('close', () => {
    if (finished) return;
    closed = true;
    for (const callback of disconnectCallbacks) callback();
  });

  return {
    send(event) {
      if (closed || raw.writableEnded || raw.destroyed) return;
      try {
        raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
      }
    },
    close() {
      finished = true;
      clearInterval(heartbeat);
      if (!raw.writableEnded) raw.end();
    },
    get closed() {
      return closed;
    },
    onDisconnect(callback) {
      disconnectCallbacks.push(callback);
      // 断连发生在注册之前（close 事件已触发）：立即补调，调用方不错过 abort 时机。
      if (closed) callback();
    },
  };
}
