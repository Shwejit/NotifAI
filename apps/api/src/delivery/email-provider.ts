import type { FastifyBaseLogger } from 'fastify';

export type EmailMessage = {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
};

export interface EmailProvider {
  sendEmail(message: EmailMessage): Promise<void>;
}

export class PermanentEmailError extends Error {}

export class MockEmailProvider implements EmailProvider {
  constructor(private readonly logger: FastifyBaseLogger) {}

  async sendEmail(message: EmailMessage): Promise<void> {
    this.logger.info(
      { to: message.to, from: message.from, subject: message.subject },
      '[EMAIL MOCK]',
    );
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  );
}

function safeActionUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function createEmailMessage(input: {
  to: string;
  from: string;
  title: string;
  body: string;
  actionUrl: string | null;
}): EmailMessage {
  const actionUrl = safeActionUrl(input.actionUrl);
  const lineBreaks = String.fromCharCode(10, 10);
  return {
    to: input.to,
    from: input.from,
    subject: input.title,
    text: input.body + (actionUrl ? lineBreaks + 'Open: ' + actionUrl : ''),
    html:
      '<p>' +
      escapeHtml(input.body) +
      '</p>' +
      (actionUrl
        ? '<p><a href="' + escapeHtml(actionUrl) + '">Open notification</a></p>'
        : ''),
  };
}
