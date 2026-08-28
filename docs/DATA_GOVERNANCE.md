# Data governance

Recruiting OS processes public recruiting pages and, only after explicit user consent, private
messages or screenshots supplied by that user. Private connector content is classified as
confidential. OAuth credentials and session secrets are classified as restricted.

## Rules

- Collect only content required to identify recruiting opportunities.
- Never expose raw connector content in student-facing responses.
- Encrypt restricted data in transit and at rest; store provider tokens only in the credential
  vault.
- Record the actor and purpose for sensitive reads and every mutation.
- Default retention is 90 days for raw private source content and at most 30 days for all terminal
  job payloads. Screenshot bytes are discarded immediately when their job succeeds or becomes
  terminal; derived public opportunity data may be retained while current.
- Support tenant export, correction, connector revocation, and deletion workflows.
- A self-service account export contains identity, membership, connector metadata, contribution
  metadata, and activity history. It never contains access/refresh tokens or raw private evidence.
- Every source version records each tenant member who independently contributed that exact content.
  Connector cursors are user-scoped so one account cannot consume another account's updates.
- Account deletion removes that tenant membership, credentials, sessions, user-owned jobs and
  cursors, and contributor links. A private Gmail, GroupMe, or screenshot version is deleted when
  the requester was its last contributor; independently shared private evidence remains for the
  remaining contributor. Public evidence remains without the contributor link.
- Deletion queues reconciliation for every organization whose private evidence was removed.
  Historical audit events and reviewed overrides remain for integrity but their actor link is
  anonymized. The global identity row is deleted once it has no tenant memberships.
- Production enablement requires named privacy and operational owners to approve this policy and
  confirm UNC-specific requirements.

Users must consent before connecting Gmail or GroupMe or uploading screenshots containing other
people's messages. The UI explains the data collected, purpose, retention, export, revocation, and
account-deletion paths.
