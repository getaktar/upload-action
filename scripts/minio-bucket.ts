// Creates a bucket on a local MinIO for the self-test workflow: node scripts/minio-bucket.ts <endpoint> <bucket>
import { EMPTY_PAYLOAD_HASH, signRequest } from '../src/s3/sigv4.ts';

const [endpoint, bucket] = process.argv.slice(2);
const url = new URL(`/${bucket}`, endpoint);
const headers = signRequest({ method: 'PUT', host: url.host, path: url.pathname, query: [], headers: {}, payloadHash: EMPTY_PAYLOAD_HASH }, { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }, 'us-east-1');
const response = await fetch(url, { method: 'PUT', headers });
if (!response.ok) throw new Error(`bucket: HTTP ${response.status} ${await response.text()}`);
console.log(`created ${bucket}`);
