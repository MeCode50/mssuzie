# Email (SMTP via Nodemailer)

Primary sources read:

- Nodemailer SMTP transport and options: <https://nodemailer.com/smtp/>
- Gmail SMTP with app passwords (587 STARTTLS / 465 TLS): <https://support.google.com/mail/answer/7126229>
- SMTP (RFC 5321) and Internet Message Format (RFC 5322): header injection arises from CR/LF in header values.

Decisions:

- Every address passes strict validation with no line breaks; subjects have line breaks stripped.
- The ALLOWLIST decides the real recipient: any other address is redirected to `DEMO_INBOX` (subject and body say who it was meant for) or blocked if there is none. Production refuses to start with an empty allowlist.
- `EMAIL_DRY_RUN=1` never opens a connection; the message is recorded as `dry_run`.
- Timeouts: connection 10s, greeting 10s, socket 20s. Provider error text (which can contain addresses and hostnames) is reduced to its error code before it is stored.
- Wording is fixed templates; no model writes an email, so a parent's message cannot put words into one.
- One message per (request, recipient role, kind): sending is idempotent, failures are retried, successes never are.

Risks: Gmail app passwords need 2-step verification and are rate limited (about 500 messages/day); fine for a demo, not for production volume (move to a transactional provider by swapping the transport).
