import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { useDialogFocus } from './useDialogFocus.js';

function Fixture() {
  const [open, setOpen] = useState(false);
  const ref = useDialogFocus<HTMLDivElement>(open, () => setOpen(false));
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && (
        <div ref={ref} role="dialog" tabIndex={-1}>
          <input aria-label="first" autoFocus />
          <button>last</button>
        </div>
      )}
    </>
  );
}

describe('useDialogFocus', () => {
  it('closes on Escape and restores the trigger focus', async () => {
    const view = render(<Fixture />);
    const trigger = view.getByText('open');
    trigger.focus();
    fireEvent.click(trigger);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(document.activeElement, view.getByLabelText('first'));
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(view.queryByRole('dialog'), null);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(document.activeElement, trigger);
  });
});
