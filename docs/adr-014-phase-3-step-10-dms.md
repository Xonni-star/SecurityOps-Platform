# ADR-014: Phase 3, step 10 document management

## Decision

Documents are tenant-scoped metadata records with append-only immutable
versions. Each version stores a provider object key, byte size, content type
and SHA-256 digest, but no blob bytes in PostgreSQL. The lifecycle is
`quarantined -> scanning -> available` or `rejected`; expired available
versions become `deleted` through the retention operation.

Storage is accessed only through `BlobStorageAdapter`, currently backed by the
MinIO/S3-compatible adapter. Malware checks use `MalwareScannerAdapter`,
currently backed by ClamAV. Provider URLs and object keys are never returned
to clients. Downloads require tenant/site authorization, an active document
and an available version; the adapter response is checked against stored size
and hash before being sent.

Database backups and blob backups are separate contracts. The DMS backup status
records provider, contract version, last backup/restore-test timestamps and
status. A healthy PostgreSQL backup does not imply recoverable blobs. The
generic offline sync protocol deliberately excludes binary content; DMS
uploads/downloads require the online API and explicit provider availability.

## Operational requirements

Set `MINIO_ENDPOINT`, `MINIO_BUCKET`, `MINIO_ACCESS_KEY` and
`MINIO_SECRET_KEY`, plus `CLAMAV_HOST`, `CLAMAV_PORT` and timeout/chunk
settings. Both Compose stacks provide a real ClamAV service and a MinIO bucket
init job; the backend healthcheck uses `/ready/dms`, which probes both
providers. A scan provider error or timeout fails closed: the version becomes
`rejected`, the blob is deleted, an audit event is recorded and the API returns
an explicit error. Provider access is injected in the isolated HTTP regression
tests; the E2E suite uses the real scanner. The harmless EICAR test string is
used only inside the isolated backend tests.
