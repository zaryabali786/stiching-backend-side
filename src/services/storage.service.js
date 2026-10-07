import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError } from '../utils/errors.js';

const BUCKET = 'evidence';
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpe?g|webp|gif|heic)|video\/(mp4|quicktime|webm))$/;

/**
 * Upload data-URL encoded files (e.g. "data:image/jpeg;base64,....") to Supabase Storage.
 * @param {string} folder e.g. `issues/<orderId>`
 * @param {{ name?: string, dataUrl: string }[]} files
 * @returns {Promise<{ url: string, path: string, type: string, name: string }[]>}
 */
export const uploadDataUrls = async (folder, files = []) => {
  const uploaded = [];
  for (const file of files.slice(0, 6)) {
    const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(file?.dataUrl || '');
    if (!match) throw new BadRequestError('Each file must be a base64 data URL.');
    const [, mime, base64] = match;
    if (!ALLOWED.test(mime)) throw new BadRequestError(`File type ${mime} is not allowed. Use a photo or a short video.`);

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > MAX_BYTES) throw new BadRequestError('Each file must be smaller than 8 MB.');

    const ext = mime.split('/')[1].replace('quicktime', 'mov').replace('jpeg', 'jpg');
    const path = `${folder}/${randomUUID()}.${ext}`;
    const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, buffer, { contentType: mime, upsert: false });
    if (error) throw new BadRequestError(`Upload failed: ${error.message}`);

    const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
    uploaded.push({ url: data.publicUrl, path, type: mime.startsWith('video') ? 'video' : 'image', name: file.name || path });
  }
  return uploaded;
};

// ─────────── Private documents (brand invoices, forwarded-email attachments) ───────────

const DOCS_BUCKET = 'documents';
const DOC_TYPES = /^(application\/pdf|image\/(png|jpe?g|webp|gif|heic))$/;
const DOC_EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };

/** True for the file types we can store and read as an invoice (PDF or image). */
export const isDocumentType = (mime) => DOC_TYPES.test(String(mime || '').toLowerCase());

/**
 * Store a buffer in the private documents bucket.
 * @returns {Promise<{ path: string, name: string, type: string, size: number }>}
 */
export const uploadDocumentBuffer = async (folder, buffer, mime, name = 'document') => {
  const type = String(mime || '').toLowerCase();
  if (!isDocumentType(type)) throw new BadRequestError('Upload a PDF or a photo/screenshot of the invoice.');
  if (buffer.length > MAX_BYTES) throw new BadRequestError('The file must be smaller than 8 MB.');
  const path = `${folder}/${randomUUID()}.${DOC_EXT[type] || 'bin'}`;
  const { error } = await supabaseAdmin.storage.from(DOCS_BUCKET).upload(path, buffer, { contentType: type, upsert: false });
  if (error) throw new BadRequestError(`Upload failed: ${error.message}`);
  return { path, name: String(name).slice(0, 160), type, size: buffer.length };
};

/** Parse a "data:<mime>;base64,..." string into { mime, buffer }. */
export const decodeDataUrl = (dataUrl) => {
  // optional media-type parameters, e.g. "data:audio/webm;codecs=opus;base64,..."
  const match = /^data:([\w/+.-]+)(?:;[\w=.+-]+)*;base64,(.+)$/s.exec(dataUrl || '');
  if (!match) throw new BadRequestError('The file must be a base64 data URL.');
  return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
};

/** Short-lived link to a private document (null when it can't be signed). */
export const signedDocumentUrl = async (path, expiresIn = 3600) => {
  if (!path) return null;
  const { data, error } = await supabaseAdmin.storage.from(DOCS_BUCKET).createSignedUrl(path, expiresIn);
  return error ? null : data.signedUrl;
};

/** Add a signed `url` to a stored { path, ... } document. */
export const withSignedUrl = async (doc) => (doc?.path ? { ...doc, url: await signedDocumentUrl(doc.path) } : doc ?? null);

// ─────────── Catalogue pictures (public bucket) ───────────

const IMAGE_ONLY = /^data:image\/(png|jpe?g|webp|gif);base64,/;

/** Upload one catalogue image (data URL) to the public bucket. @returns {{ url: string, path: string }} */
export const uploadCatalogueImage = async (folder, file) => {
  if (!IMAGE_ONLY.test(file?.dataUrl || '')) throw new BadRequestError('Upload a JPG, PNG or WebP picture.');
  const [uploaded] = await uploadDataUrls(folder, [file]);
  return { url: uploaded.url, path: uploaded.path };
};

/** Best-effort delete from a bucket; never throws (a leftover file is harmless). */
export const removeStoredFile = async (bucket, path) => {
  if (!path) return;
  try {
    await supabaseAdmin.storage.from(bucket).remove([path]);
  } catch (err) {
    console.warn('[Storage] could not remove', path, err.message);
  }
};

// ─────────── Voice notes (private bucket, served through signed URLs) ───────────

const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|x-m4a|aac|m4a)$/;
const AUDIO_EXT = { webm: 'webm', ogg: 'ogg', mp4: 'm4a', mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', 'x-m4a': 'm4a', aac: 'aac', m4a: 'm4a' };

/**
 * Store a voice clip. `folder` should already include the order and sender so paths can be authorised later.
 * @returns {{ path: string, mime: string, size: number }}
 */
export const uploadAudio = async (folder, dataUrl) => {
  const { mime: rawMime, buffer } = decodeDataUrl(dataUrl);
  // browsers add codec info: "audio/webm;codecs=opus" arrives as the base mime type
  const mime = rawMime.split(';')[0];
  if (!AUDIO_TYPES.test(mime)) throw new BadRequestError('That audio format is not supported.');
  if (buffer.length < 200) throw new BadRequestError('The recording is empty.');
  if (buffer.length > MAX_BYTES) throw new BadRequestError('The voice note must be smaller than 8 MB.');
  const path = `${folder}/${randomUUID()}.${AUDIO_EXT[mime.split('/')[1]] || 'webm'}`;
  const { error } = await supabaseAdmin.storage.from(DOCS_BUCKET).upload(path, buffer, { contentType: mime, upsert: false });
  if (error) throw new BadRequestError(`Upload failed: ${error.message}`);
  return { path, mime, size: buffer.length };
};

export const documentExists = async (path) => {
  const { data, error } = await supabaseAdmin.storage.from(DOCS_BUCKET).exists(path);
  return !error && !!data;
};
