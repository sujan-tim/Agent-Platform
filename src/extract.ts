/**
 * Turns an uploaded file into plain text the agent can search.
 *
 * Supports text and Markdown, PDF (through unpdf, a packaging of Mozilla's
 * pdf.js) and Word .docx (through mammoth). The type is decided by the file's
 * first bytes where it can be, not only its name: a PDF starts with "%PDF-",
 * and a .docx is a zip file, which starts with "PK".
 *
 * Scanned PDFs are pictures of pages with no text inside; they come back
 * empty and are refused with a message saying so (reading them needs OCR).
 */

import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

export type FileKind = 'pdf' | 'docx' | 'text';

export class ExtractError extends Error {}

export function detectKind(filename: string, data: Uint8Array): FileKind {
  const head = Buffer.from(data.subarray(0, 5)).toString('latin1');
  if (head === '%PDF-') return 'pdf';
  const lower = filename.toLowerCase();
  if (head.startsWith('PK') && lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.doc')) throw new ExtractError('Old Word .doc files are not supported. Save it as .docx and upload again.');
  if (/\.(txt|md|markdown|csv)$/.test(lower)) return 'text';
  throw new ExtractError('Upload a PDF, Word (.docx), text or Markdown file.');
}

export async function extractFileText(filename: string, data: Uint8Array): Promise<{ kind: FileKind; text: string }> {
  const kind = detectKind(filename, data);
  let text: string;
  try {
    if (kind === 'pdf') {
      // pdf.js takes ownership of the buffer it is given, so hand it a copy;
      // verbosity 0 keeps its repair warnings for damaged files out of the server log.
      const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
      const { text: pages } = await extractText(pdf, { mergePages: false });
      // A blank line between pages, so search treats them as separate passages.
      text = (pages as string[]).join('\n\n');
    } else if (kind === 'docx') {
      text = (await mammoth.extractRawText({ buffer: Buffer.from(data) })).value;
    } else {
      text = new TextDecoder('utf-8').decode(data);
    }
  } catch (err) {
    throw new ExtractError(`Could not read that ${kind === 'pdf' ? 'PDF' : 'Word file'}: ${err instanceof Error ? err.message : err}`);
  }
  text = tidy(text);
  if (!text) {
    throw new ExtractError(
      kind === 'pdf'
        ? 'That PDF has no text in it. It is probably a scan; scanned pages need OCR, which is not supported yet.'
        : 'That file has no text in it.',
    );
  }
  return { kind, text };
}

/** Normalises line endings and spacing, and keeps at most one blank line between paragraphs. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
