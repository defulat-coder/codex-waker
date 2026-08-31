import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { render, screen } from '@testing-library/react';
import { LegacyRail } from './LegacyWorkbench.js';

describe('LegacyRail', () => {
  it('uses one accessible custom label instead of a duplicate native tooltip', () => {
    render(<LegacyRail active="wakers" unreadCount={0} onChange={() => undefined} />);

    const chat = screen.getByRole('button', { name: 'Chat' });
    assert.equal(chat.getAttribute('title'), null);
    assert.equal(chat.querySelector('.legacy-rail-label')?.textContent, 'Chat');
  });
});
