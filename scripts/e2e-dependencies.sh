#!/usr/bin/env bash
set -euo pipefail

# Isolated E2E-only dependencies for the local Compose stack; never use this in production.
repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo_root"

docker compose version >/dev/null || { echo "docker compose is required" >&2; exit 1; }

echo "Preparing isolated DMS bucket"
docker compose exec -T backend node --input-type=module -e '
import {CreateBucketCommand, HeadBucketCommand, S3Client} from "@aws-sdk/client-s3";
const client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});
const bucket = process.env.MINIO_BUCKET || "securityops-dms";
try {
  await client.send(new HeadBucketCommand({Bucket: bucket}));
} catch (error) {
  const missing = error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404;
  if (!missing) throw error;
  try {
    await client.send(new CreateBucketCommand({Bucket: bucket}));
  } catch (createError) {
    const exists = ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(createError?.name);
    if (!exists) throw createError;
  }
}
console.log(`DMS bucket ready: ${bucket}`);
'

echo "Waiting for the real ClamAV service and DMS storage"
# Der frühere E2E-Fake-Scanner im Backend-Container ist bewusst entfernt: er
# hat jeden Upload ungeprüft freigegeben. E2E läuft jetzt gegen denselben
# echten ClamAV-Dienst wie der Regelbetrieb. Die offizielle EICAR-Testsignatur
# wird ausschließlich in den isolierten Backend-Tests verwendet.
for _ in $(seq 1 60); do
  if docker compose exec -T backend wget -qO- http://127.0.0.1:3000/ready/dms >/dev/null 2>&1; then
    echo "E2E dependencies ready"
    exit 0
  fi
  sleep 1
done

echo "DMS storage or real ClamAV scanner did not become ready" >&2
docker compose logs --no-color clamav backend | tail -80 >&2
exit 1
