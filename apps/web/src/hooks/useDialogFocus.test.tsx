import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useLayoutEffect, useRef, useState } from 'react';
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

function PreFocusedField() {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  return <input ref={ref} aria-label="preferred" />;
}

function PreFocusedFixture() {
  const [open, setOpen] = useState(false);
  const ref = useDialogFocus<HTMLDivElement>(open, () => setOpen(false));
  return (
    <>
      <button onClick={() => setOpen(true)}>open preferred</button>
      {open && (
        <div ref={ref} role="dialog" tabIndex={-1}>
          <button aria-label="close">close</button>
          <PreFocusedField />
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

  it('restores a mouse trigger that the platform does not focus on click', async () => {
    const view = render(<Fixture />);
    const trigger = view.getByText('open');
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(document.activeElement, view.getByLabelText('first'));

    fireEvent.keyDown(document, { key: 'Escape' });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(document.activeElement, trigger);
  });

  it('preserves focus already placed inside the dialog before its fallback frame', async () => {
    const view = render(<PreFocusedFixture />);
    fireEvent.click(view.getByText('open preferred'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(document.activeElement, view.getByLabelText('preferred'));
  });
});
