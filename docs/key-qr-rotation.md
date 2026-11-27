# KEY_QR_SECRET rotation

`KEY_QR_SECRET` signs the short-lived QR references issued by
`GET /api/v1/keys/:id/qr`. References expire after 15 minutes. The raw secret
never reaches the browser or the database: the database stores only a SHA-256
hash of each token, and verification uses a constant-time HMAC comparison.

## Rules

- Generate a fresh value with `openssl rand -hex 32`; never reuse
  `MFA_ENCRYPTION_KEY`, `BACKUP_SECRET_KEY`, `WATCHBOOK_HASH_SECRET` or a value
  already present in a commit, fixture or CI script.
- Backend validation is authoritative: length 32–512, high entropy, no
  whitespace/control characters, distinct from other secrets and from the
  retired secret. A missing secret stops every runtime except local
  development/test.
- Reissuing a QR for a key deletes that key's stored hashes first; an old label
  is revoked immediately even when the signing key has not changed.

## Zero-downtime rotation

1. Set `KEY_QR_SECRET_PREVIOUS=<old value>` in the deployment secret store and
   replace `KEY_QR_SECRET=<new value>`. Keep both values available to every
   backend replica.
2. Roll/restart the backend. Verification accepts signatures from both keys;
   issuance uses only the new key. Confirm
   `GET /ready` plus an existing QR reference still verifies.
3. Wait longer than the 15-minute QR lifetime.
4. Remove `KEY_QR_SECRET_PREVIOUS` and restart/reload. Any reference signed with
   the old key is now rejected with `400 KEY_QR_INVALID`.
5. Keep the old secret out of version control and delete it from the secret
   store once the window has closed.

Only one retired secret is needed for a single rotation step. If an emergency
requires immediate invalidation of already issued labels, reissue the QR for the
affected keys (or delete their `key_qr_tokens` rows under the tenant scope);
the database hash check then rejects them independently of the signing key.
