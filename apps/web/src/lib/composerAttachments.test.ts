import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatAttachmentBytes,
  MAX_TURN_ATTACHMENTS,
  prepareComposerAttachments,
} from './composerAttachments.js';

describe('prepareComposerAttachments', () => {
  it('保留可发送文本/图片并逐文件拒绝敏感、空和不支持类型', async () => {
    const result = await prepareComposerAttachments([
      new File(['hello'], 'guide.md', { type: 'text/markdown', lastModified: 1 }),
      new File(['image'], 'shot.png', { type: 'image/png', lastModified: 2 }),
      new File(['secret'], '.env', { type: 'text/plain', lastModified: 3 }),
      new File([], 'empty.txt', { type: 'text/plain', lastModified: 4 }),
      new File(['pdf'], 'report.pdf', { type: 'application/pdf', lastModified: 5 }),
    ]);

    assert.deepEqual(
      result.accepted.map((item) => [item.originalName, item.mimeType]),
      [
        ['guide.md', 'text/markdown'],
        ['shot.png', 'image/png'],
      ],
    );
    assert.equal(result.accepted[0]!.dataBase64, 'aGVsbG8=');
    assert.deepEqual(
      result.rejected.map((item) => item.originalName),
      ['.env', 'empty.txt', 'report.pdf'],
    );
  });

  it('限制重复文件和每轮数量，同时保留同批可用文件', async () => {
    const existing = (
      await prepareComposerAttachments([
        new File(['same'], 'same.txt', { type: 'text/plain', lastModified: 1 }),
      ])
    ).accepted;
    const files = [
      new File(['same'], 'same.txt', { type: 'text/plain', lastModified: 1 }),
      ...Array.from(
        { length: MAX_TURN_ATTACHMENTS },
        (_, index) =>
          new File([String(index)], `${index}.txt`, {
            type: 'text/plain',
            lastModified: index + 2,
          }),
      ),
    ];
    const result = await prepareComposerAttachments(files, existing);
    assert.equal(result.accepted.length, MAX_TURN_ATTACHMENTS - 1);
    assert.equal(result.rejected.length, 2);
    assert.match(result.rejected[0]!.reason, /已在待发送/);
    assert.match(result.rejected[1]!.reason, /最多还能使用 8/);
    const noSlots = await prepareComposerAttachments(
      [new File(['x'], 'blocked.txt', { type: 'text/plain' })],
      [],
      0,
    );
    assert.equal(noSlots.accepted.length, 0);
    assert.match(noSlots.rejected[0]!.reason, /没有剩余附件名额/);
  });
});

describe('formatAttachmentBytes', () => {
  it('按 B/KB/MB 显示紧凑大小', () => {
    assert.equal(formatAttachmentBytes(12), '12 B');
    assert.equal(formatAttachmentBytes(1025), '2 KB');
    assert.equal(formatAttachmentBytes(2 * 1024 * 1024), '2.0 MB');
  });
});
