import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { useState } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { usePanelFocus } from './usePanelFocus.js';

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open ? <Panel onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const ref = usePanelFocus<HTMLElement>(onClose);
  return (
    <aside ref={ref} aria-label="panel" tabIndex={-1}>
      <button data-panel-close onClick={onClose}>
        close
      </button>
      <button>action</button>
    </aside>
  );
}

describe('usePanelFocus', () => {
  it('focuses the close action, closes on Escape and restores its trigger', () => {
    const view = render(<Fixture />);
    const trigger = view.getByText('open');
    trigger.focus();
    fireEvent.click(trigger);
    assert.equal(document.activeElement, view.getByText('close'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    assert.equal(view.queryByLabelText('panel'), null);
    assert.equal(document.activeElement, trigger);
  });
});
