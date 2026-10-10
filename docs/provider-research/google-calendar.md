# Google Calendar (service account)

Primary sources read:

- Service-account auth over REST (JWT bearer grant, RFC 7523): <https://developers.google.com/identity/protocols/oauth2/service-account#httprest>
- Events: insert and patch: <https://developers.google.com/calendar/api/v3/reference/events/insert>, <https://developers.google.com/calendar/api/v3/reference/events/patch>
- Scopes: <https://developers.google.com/calendar/api/auth> (`calendar.events` is enough to edit events on a calendar shared with the account)
- Usage limits and 403/429 handling: <https://developers.google.com/calendar/api/guides/errors>

Decisions that follow from them:

- Auth is a signed RS256 JWT exchanged for a one-hour access token; the token is cached and refreshed a minute early.
- The service account is a separate identity: the target calendar must be shared with its email with "Make changes to events". A 403/404 therefore reports exactly that hint.
- Event ids are supplied by us (the booking id without dashes: Google allows a-v and 0-9, 5-1024 chars). Updating is a PATCH; a 404 falls back to creating with the same id. Both are safe to repeat. `status: confirmed` revives an event someone deleted by hand.
- Times are sent as UTC instants with an explicit `timeZone`, never as local strings.
- 429 and 5xx are retried with exponential backoff (3 attempts); everything else fails at once and is shown on the run trace.
- Only the learner's and tutor's first names go on the calendar event.
- Personal Gmail calendars and Workspace calendars both work with this model; domain-wide delegation is NOT used and not needed.

Risks: the key file is a secret (base64 in an env var, never logged); a deleted or unshared calendar makes every move end "partial" until fixed.
