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

echo "Preparing isolated ClamAV test scanner"
if ! docker compose exec -T backend node -e '
const net = require("node:net");
const socket = net.createConnection({host: "127.0.0.1", port: 3310});
socket.on("connect", () => { socket.end(); process.exit(0); });
socket.on("error", () => process.exit(1));
' >/dev/null 2>&1; then
  docker compose exec -d backend node -e '
const net = require("node:net");
net.createServer(socket => {
  socket.resume();
  socket.on("error", () => undefined);
  socket.on("end", () => {
    if (!socket.destroyed) socket.end("stream: OK\0");
  });
}).on("error", error => {
  console.error(error);
  process.exit(1);
}).listen(3310, "0.0.0.0", () => console.log("Isolated ClamAV test scanner ready on 3310"));
'
fi

for _ in $(seq 1 30); do
  if docker compose exec -T backend node -e '
const net = require("node:net");
const socket = net.createConnection({host: "127.0.0.1", port: 3310});
socket.on("connect", () => { socket.end(); process.exit(0); });
socket.on("error", () => process.exit(1));
' >/dev/null 2>&1; then
    echo "E2E dependencies ready"
    exit 0
  fi
  sleep 1
done

echo "Isolated ClamAV test scanner did not become ready" >&2
docker compose logs --no-color backend | tail -50 >&2
exit 1
