// JWKS 환경변수 값을 만든다: npm run gen-keys
import { generateKeyPairSync, randomUUID } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: 'ES256' };
console.log(JSON.stringify({ keys: [jwk] }));
