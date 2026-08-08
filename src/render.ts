/**
 * Alert rendering.
 *
 * Security note that governs this whole file: **alert summaries contain text scraped
 * from third-party websites.** A subprocessor name, a stated purpose, a clause quote —
 * all of it originates on a page we do not control. `inlineText` strips tags during
 * extraction, but it also *decodes entities*, so a vendor page containing the literal
 * string `&lt;script&gt;` yields the text `<script>` in our database. Interpolating
 * that into an HTML email unescaped is a straight injection path into the customer's
 * inbox. Everything vendor-derived goes through `escapeHtml` or `escapeSlack`.
 */

import type { StoredAlert } from './notify.ts';

export interface OutboundMessage {
  subject: string;
  text: string;
  html: string;
  slack: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Slack's mrkdwn requires exactly these three, and no more. */
export function escapeSlack(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const KIND_PREFIX: Record<StoredAlert['kind'], string> = {
  change: '',
  watch_broken: "Can't check — ",
  watch_relocated: 'Page moved — ',
};

const reviewUrl = (base: string, alert: StoredAlert) => `${base}/alerts/${alert.id}`;

function subjectFor(alerts: StoredAlert[]): string {
  if (alerts.length === 1) return truncate(`${KIND_PREFIX[alerts[0].kind]}${alerts[0].summary}`, 140);
  const changes = alerts.filter((a) => a.kind === 'change').length;
  return changes === alerts.length
    ? `${changes} vendor changes need review`
    : `${alerts.length} vendor updates need review`;
}

function line(alert: StoredAlert): string {
  return `${KIND_PREFIX[alert.kind]}${alert.summary}`;
}

const SIGNOFF_TEXT =
  'Every check is logged — including the ones where nothing changed. That log is what you export at audit time.';

export function renderAlerts(alerts: StoredAlert[], appBaseUrl: string, digest?: 'daily' | 'weekly'): OutboundMessage | null {
  // Never send an empty message. A digest that arrives saying "nothing happened" is
  // the fastest way to train someone to filter you into a folder.
  if (!alerts.length) return null;

  const subject = digest
    ? `Your ${digest} digest — ${alerts.length} change${alerts.length > 1 ? 's' : ''} logged`
    : subjectFor(alerts);

  const heading = digest
    ? `${alerts.length} change${alerts.length > 1 ? 's' : ''} logged since your last digest.`
    : `${alerts.length} update${alerts.length > 1 ? 's' : ''} need${alerts.length > 1 ? '' : 's'} review.`;

  const text = [
    heading,
    '',
    ...alerts.map((a) => `• ${line(a)}\n  Review → ${reviewUrl(appBaseUrl, a)}`),
    '',
    SIGNOFF_TEXT,
    `Manage alerts: ${appBaseUrl}/settings`,
  ].join('\n');

  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:600px">',
    `<p style="margin:0 0 16px">${escapeHtml(heading)}</p>`,
    ...alerts.map(
      (a) =>
        `<div style="border-left:3px solid ${a.severity === 'high' ? '#b42318' : '#98a2b3'};padding:8px 0 8px 12px;margin:0 0 12px">` +
        `<div>${escapeHtml(line(a))}</div>` +
        `<a href="${escapeHtml(reviewUrl(appBaseUrl, a))}" style="font-size:14px">Review</a>` +
        '</div>',
    ),
    `<p style="color:#667085;font-size:13px;margin:24px 0 0">${escapeHtml(SIGNOFF_TEXT)}</p>`,
    `<p style="font-size:13px;margin:8px 0 0"><a href="${escapeHtml(`${appBaseUrl}/settings`)}">Manage alerts</a></p>`,
    '</div>',
  ].join('');

  const slack = [
    `*${escapeSlack(heading)}*`,
    ...alerts.map((a) => `• ${escapeSlack(line(a))}  <${reviewUrl(appBaseUrl, a)}|Review>`),
  ].join('\n');

  return { subject, text, html, slack };
}
