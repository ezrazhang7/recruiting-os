import { createHash, randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const uid = (prefix: string) => `${prefix}_${randomUUID()}`;
export const stableId = (prefix: string, value: string) =>
  `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;

export function stripTrailingPunctuation(url: string): string {
  return url.replace(/[),.;!?]+$/g, '');
}

export function extractUrls(text: string): string[] {
  const hits = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return [...new Set(hits.map(stripTrailingPunctuation))];
}

export function parseJsonSafe<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

export function normalizeHandle(v: string): string {
  return v.trim().replace(/^@/, '').toLowerCase();
}
