import { BadRequestError } from '../utils/error.helper.js';
import { documentExists, signedDocumentUrl, uploadAudio } from './storage.service.js';
import { MAX_VOICE_SECONDS } from './chat.service.js';

/**
 * Voice notes that sit next to a text note (article note, size note, change request, job comment,
 * QC note, receiving issue). The clip is uploaded first (private bucket, folder per person) and the
 * note stores only a small reference: { path, mime, duration, size }. Responses carry a short-lived
 * signed link instead of the path.
 */

export const NOTE_AUDIO_FOLDER = (userId) => `voice/notes/${userId}`;

/** Store a recording for the signed-in user. @returns {{ path, mime, size, duration, url }} */
export const uploadNoteVoice = async (userId, audio) => {
  if (!audio?.dataUrl) throw new BadRequestError('Record a voice note first.');
  const duration = Number(audio.duration);
  if (!Number.isFinite(duration) || duration < 0.3) throw new BadRequestError('The recording is too short.');
  if (duration > MAX_VOICE_SECONDS) throw new BadRequestError(`Voice notes can be at most ${MAX_VOICE_SECONDS / 60} minutes.`);
  const stored = await uploadAudio(NOTE_AUDIO_FOLDER(userId), audio.dataUrl);
  return { ...stored, duration, url: await signedDocumentUrl(stored.path, 3600) };
};

/**
 * Validate a voice reference sent with a note. Only files this person uploaded count.
 * @returns {Promise<object|null|undefined>} undefined = not provided, null = explicitly removed, object = valid reference
 */
export const cleanVoiceNote = async (ref, userId) => {
  if (ref === undefined) return undefined;
  if (ref === null) return null;
  const path = String(ref.path || '');
  // an echoed, already signed object (no path) means "keep what is saved": callers treat that as undefined
  if (!path) return undefined;
  if (!path.startsWith(`${NOTE_AUDIO_FOLDER(userId)}/`) || path.includes('..')) throw new BadRequestError('This voice note is not valid. Please record it again.');
  const duration = Number(ref.duration);
  if (!Number.isFinite(duration) || duration < 0.3 || duration > MAX_VOICE_SECONDS) throw new BadRequestError('This voice note has an invalid length.');
  if (!(await documentExists(path))) throw new BadRequestError('The voice note was not uploaded. Please record it again.');
  return { path, mime: String(ref.mime || 'audio/webm').slice(0, 60), duration: Math.round(duration * 10) / 10, size: Number(ref.size) || null };
};

const NOTE_AUDIO_KEYS = new Set(['notes_audio', 'issue_audio', 'change_request_audio', 'qc_notes_audio']);

/**
 * Walk a response and turn every stored voice reference into { mime, duration, size, url } (the path is dropped).
 * Mutates and returns the same value.
 */
export const signNoteAudio = async (node) => {
  const jobs = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    for (const [key, child] of Object.entries(value)) {
      if (NOTE_AUDIO_KEYS.has(key) && child && typeof child === 'object' && child.path) {
        jobs.push(
          signedDocumentUrl(child.path, 3600).then((url) => {
            value[key] = { mime: child.mime, duration: child.duration ?? null, size: child.size ?? null, url };
          }),
        );
      } else {
        visit(child);
      }
    }
  };
  visit(node);
  await Promise.all(jobs);
  return node;
};
