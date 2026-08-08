/**
 * Outbound channels: Resend for email, incoming webhooks for Slack.
 *
 * Both return the same three-way answer — sent, failed-and-worth-retrying, or
 * failed-permanently — because the retry decision is the only thing the caller
 * actually needs. Retrying a rejected recipient forever is how a sending domain earns
 * a reputation problem, and a reputation problem in an alerting product is fatal in a
 * way a missed webhook is not.
 */

import type { OutboundMessage } from './render.ts';

export interface SendResult {
  ok: boolean;
  retryable: boolean;
  error?: string;
  /** Set when the destination itself is gone and should be cleared from settings. */
  destinationRevoked?: boolean;
}

export interface Channels {
  sendEmail(to: string[], message: OutboundMessage): Promise<SendResult>;
  sendSlack(webhookUrl: string, message: OutboundMessage): Promise<SendResult>;
}

/** 429 and 5xx are the vendor's problem and will pass; 4xx is ours and won't. */
const retryableStatus = (status: number) => status === 429 || status >= 500;

export function createChannels(opts: {
  resendApiKey: string;
  fromAddress: string;
  fetchImpl?: typeof fetch;
}): Channels {
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async sendEmail(to, message) {
      if (!to.length) return { ok: false, retryable: false, error: 'no recipients configured' };
      try {
        const response = await doFetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.resendApiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: opts.fromAddress,
            to,
            subject: message.subject,
            text: message.text,
            html: message.html,
          }),
        });
        if (response.ok) return { ok: true, retryable: false };
        return {
          ok: false,
          retryable: retryableStatus(response.status),
          error: `resend ${response.status}: ${(await response.text()).slice(0, 200)}`,
        };
      } catch (err) {
        // A network fault is transient by definition.
        return { ok: false, retryable: true, error: `resend request failed: ${message0(err)}` };
      }
    },

    async sendSlack(webhookUrl, message) {
      try {
        const response = await doFetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: message.slack, unfurl_links: false }),
        });
        if (response.ok) return { ok: true, retryable: false };
        // Slack answers a deleted webhook with 404/410 forever. Keeping it on file
        // means every future alert burns a request and logs a failure that no one can
        // fix except by noticing — so we clear it and tell the workspace once.
        const revoked = response.status === 404 || response.status === 410;
        return {
          ok: false,
          retryable: !revoked && retryableStatus(response.status),
          destinationRevoked: revoked,
          error: `slack ${response.status}`,
        };
      } catch (err) {
        return { ok: false, retryable: true, error: `slack request failed: ${message0(err)}` };
      }
    },
  };
}

const message0 = (err: unknown) => (err instanceof Error ? err.message : String(err));
