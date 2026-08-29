import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { MotionLoadingRows, MotionPulseDot, MotionSpinner } from './MotionFeedback.js';

describe('MotionFeedback', () => {
  it('keeps loading feedback semantic while Motion owns the animation', () => {
    const { container } = render(
      <>
        <MotionSpinner>
          <span>loading</span>
        </MotionSpinner>
        <MotionPulseDot className="test-pulse" />
        <MotionLoadingRows count={2} label="正在读取数据" />
      </>,
    );

    assert.equal(screen.getByRole('status', { name: '正在读取数据' }).ariaBusy, 'true');
    assert.equal(container.querySelectorAll('.loading-rows > i').length, 2);
    assert.ok(container.querySelector('.motion-spinner'));
    assert.ok(container.querySelector('.test-pulse'));
  });
});
