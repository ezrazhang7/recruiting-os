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
- Default retention is 90 days for raw private source content and 30 days for failed job payloads;
  derived public opportunity data may be retained while current.
- Support tenant export, correction, connector revocation, and deletion workflows.
- Deletion requests remove private source versions, credentials, and sessions, then queue derived
  data reconciliation.
- Production enablement requires named privacy and operational owners to approve this policy and
  confirm UNC-specific requirements.

Users must consent before connecting Gmail or GroupMe or uploading screenshots containing other
people's messages. The UI must explain the data collected, purpose, retention, and revocation path.
