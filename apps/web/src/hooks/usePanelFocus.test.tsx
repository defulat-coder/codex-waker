import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { useRef, useState } from 'react';
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

function Panel({ onClose, returnFocusId }: { onClose: () => void; returnFocusId?: string }) {
  const ref = usePanelFocus<HTMLElement>(onClose, returnFocusId);
  return (
    <aside ref={ref} aria-label="panel" tabIndex={-1}>
      <button data-panel-close onClick={onClose}>
        close
      </button>
      <button>action</button>
    </aside>
  );
}

function ExplicitTriggerFixture() {
  const [open, setOpen] = useState(false);
  const otherRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        id="explicit-panel-trigger"
        onClick={() => {
          otherRef.current?.focus();
          setOpen(true);
        }}
      >
        explicit open
      </button>
      <input ref={otherRef} aria-label="other" />
      {open ? (
        <Panel onClose={() => setOpen(false)} returnFocusId="explicit-panel-trigger" />
      ) : null}
    </>
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

  it('restores an explicit trigger when pointer focus stayed elsewhere', () => {
    const view = render(<ExplicitTriggerFixture />);
    const trigger = view.getByText('explicit open');
    fireEvent.click(trigger);
    assert.equal(document.activeElement, view.getByText('close'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    assert.equal(document.activeElement, trigger);
  });
});
