/** node:test 的全局 setup：先注册 jsdom 全局，再接管每个用例后的组件清理。 */
import './test-jsdom.js';
import { afterEach } from 'node:test';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());
