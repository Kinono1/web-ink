import { describe, expect, it } from 'vitest';
import { parseBackup, serializeBackup, toMarkdown } from '../src/core/backup';
import type { TextAnnotation } from '../src/core/model';
import { MAX_BACKUP_ANNOTATIONS, MAX_BACKUP_BYTES } from '../src/core/validation';

function annotation(id = 'a-1'): TextAnnotation {
  return {
    id, pageUrl: 'https://example.test/article', pageTitle: 'Article', color: '#facc15', note: 'note *with* markup', tags: ['tag_one'],
    createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', revision: 1, kind: 'text',
    target: { exact: 'source [text]', prefix: '', suffix: '', start: 0, end: 13, rootSelector: 'article' },
  };
}

describe('backup serialization', () => {
  it('returns a versioned, independently validated envelope', () => {
    const backup = serializeBackup([annotation('z-1'), annotation('a-1')], { language: 'en', defaultColor: '#ffffff', disabledOrigins: [] });
    expect(backup).toMatchObject({ format: 'web-ink', schemaVersion: 2, annotations: [expect.objectContaining({ id: 'a-1' }), expect.objectContaining({ id: 'z-1' })] });
    expect(parseBackup(backup)).toEqual(backup);
  });

  it('rejects duplicate ids and inconsistent text offsets', () => {
    const backup = { format: 'web-ink', schemaVersion: 2, exportedAt: '2026-09-18T00:00:00.000Z', annotations: [annotation(), annotation()] };
    expect(() => parseBackup(backup)).toThrow('duplicate IDs');
    expect(() => parseBackup({ ...backup, annotations: [{ ...annotation(), target: { ...annotation().target, end: 12 } }] })).toThrow('offsets disagree');
  });

  it('enforces backup quotas and rejects hidden control characters', () => {
    const header = { format: 'web-ink', schemaVersion: 2, exportedAt: '2026-09-18T00:00:00.000Z' };
    expect(() => parseBackup({ ...header, annotations: Array.from({ length: MAX_BACKUP_ANNOTATIONS + 1 }, () => ({})) })).toThrow('at most');
    expect(() => parseBackup({ ...header, annotations: [], padding: 'x'.repeat(MAX_BACKUP_BYTES) })).toThrow('exceeds');
    expect(() => parseBackup({ ...header, annotations: [{ ...annotation(), note: 'hidden\u0001control' }] })).toThrow('plain text');
  });

  it('renders Markdown as a text index and escapes annotation text', () => {
    const markdown = toMarkdown([annotation()]);
    expect(markdown).toContain('URL: https://example.test/article');
    expect(markdown).toContain('Text quotation:\n> source \\[text\\]');
    expect(markdown).toContain('Note: note \\*with\\* markup');
    expect(markdown).not.toContain('![');
  });

  it('renders multiline title, tags, notes, and quotes as literal text', () => {
    const record = annotation();
    record.pageTitle = '# Heading\n![title](https://example.test/title.png)';
    record.tags = ['tag\n- nested', '[link](https://example.test)'];
    record.note = 'note\n## fake section\n![note](https://example.test/note.png)';
    record.target.exact = 'first line\n## not a section\n![not an image](https://example.test/image.png)';
    record.target.end = record.target.exact.length;

    const markdown = toMarkdown([record]);
    expect(markdown).toContain('- Page title: \\# Heading\\n\\!\\[title\\]\\(https://example.test/title.png\\)');
    expect(markdown).toContain('- Tags: tag\\n\\- nested, \\[link\\]\\(https://example.test\\)');
    expect(markdown).toContain('- Note: note\\n\\#\\# fake section\\n\\!\\[note\\]\\(https://example.test/note.png\\)');
    expect(markdown).toContain('> first line\n> \\#\\# not a section\n> \\!\\[not an image\\]\\(https://example.test/image.png\\)');
    expect(markdown).not.toContain('\n## fake section');
    expect(markdown).not.toContain('\n![note]');
  });

  it('imports a schema v1 envelope and normalizes it to v2', () => {
    const legacy = { format: 'web-ink', schemaVersion: 1, exportedAt: '2026-09-18T00:00:00.000Z', annotations: [annotation()] };
    expect(parseBackup(legacy)).toMatchObject({ schemaVersion: 2, annotations: [expect.objectContaining({ id: 'a-1', kind: 'text' })] });
  });
});
