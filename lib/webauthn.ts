/**
 * A software WebAuthn authenticator for E2E suites (test only): ES256 credential, `packed` self
 * attestation, all-zero AAGUID, user present + verified, not backed up. identity accepts the all-zero
 * AAGUID from the operator allow-list only when `NP_ENV` is `local` or `test` (identity §11), which is
 * what nearpay-deploy's local list allows; on a server stack this authenticator is refused by design.
 *
 * It answers the JSON options `@simplewebauthn/server` produces and returns the JSON
 * `RegistrationResponseJSON` / `AuthenticationResponseJSON` shapes the spec routes accept.
 */
import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

// ---- minimal CBOR (RFC 8949) encoder: unsigned/negative ints, byte/text strings, maps ----------------
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, x] of v) parts.push(cbor(k), cbor(x));
  return Buffer.concat(parts);
}

export interface SoftCredential {
  id: string;
  /** PKCS#8 PEM of the P-256 private key (kept so a suite can sign in again). */
  privateKeyPem: string;
  userHandle: string;
  rpId: string;
  signCount: number;
}

interface RegistrationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string };
}
interface AuthenticationOptionsJSON {
  challenge: string;
  rpId?: string;
}

function authData(rpId: string, flags: number, signCount: number, attested?: Buffer): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(signCount >>> 0);
  return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
}

function cosePublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as { x: string; y: string };
  return cbor(
    new Map<Cbor, Cbor>([
      [1, 2], // kty EC2
      [3, -7], // alg ES256
      [-1, 1], // crv P-256
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]),
  );
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

/** `navigator.credentials.create()` for `origin`: a new credential and its registration response. */
export function createCredential(options: RegistrationOptionsJSON, origin: string) {
  const rpId = options.rp.id ?? new URL(origin).hostname;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credId = randomBytes(32);
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }),
  );
  const attested = Buffer.concat([
    Buffer.alloc(16), // AAGUID 00000000-0000-0000-0000-000000000000
    Buffer.from([credId.length >> 8, credId.length & 0xff]),
    credId,
    cosePublicKey(publicKey),
  ]);
  const ad = authData(rpId, UP | UV | AT, 0, attested);
  const sig = sign("sha256", Buffer.concat([ad, sha256(clientDataJSON)]), privateKey);
  const attestationObject = cbor(
    new Map<Cbor, Cbor>([
      ["fmt", "packed"],
      [
        "attStmt",
        new Map<Cbor, Cbor>([
          ["alg", -7],
          ["sig", sig],
        ]),
      ],
      ["authData", ad],
    ]),
  );
  const credential: SoftCredential = {
    id: b64u(credId),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    userHandle: options.user.id,
    rpId,
    signCount: 0,
  };
  const response = {
    id: credential.id,
    rawId: credential.id,
    type: "public-key" as const,
    response: {
      clientDataJSON: b64u(clientDataJSON),
      attestationObject: b64u(attestationObject),
      transports: ["usb"],
    },
    clientExtensionResults: {},
    authenticatorAttachment: "cross-platform" as const,
  };
  return { credential, response };
}

/** `navigator.credentials.get()` for `origin` with an existing credential (sign count bumped). */
export function getAssertion(options: AuthenticationOptionsJSON, origin: string, c: SoftCredential) {
  c.signCount += 1;
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }),
  );
  const ad = authData(options.rpId ?? c.rpId, UP | UV, c.signCount);
  const signature = sign("sha256", Buffer.concat([ad, sha256(clientDataJSON)]), createPrivateKey(c.privateKeyPem));
  return {
    id: c.id,
    rawId: c.id,
    type: "public-key" as const,
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(ad),
      signature: b64u(signature),
      userHandle: c.userHandle,
    },
    clientExtensionResults: {},
    authenticatorAttachment: "cross-platform" as const,
  };
}
