import { createContext } from 'react';

/**
 * 当前 Markdown 所属消息是否仍在流式输出。
 * 代码块借此决定增强渲染（Mermaid 出图、Shiki 高亮）何时接管：
 * 流式期间保持纯文本，消息完成后再增强，避免对不完整代码块做 parse。
 */
export const MessageStreamingContext = createContext(false);
