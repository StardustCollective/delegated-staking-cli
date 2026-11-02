import crypto from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

export class InvalidKeyError extends Error {
  constructor() {
    super('Invalid private key: expected 64 hex characters (optionally prefixed with 0x), non-zero and below the curve order.');
    this.name = 'InvalidKeyError';
  }
}

const CURVE_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

export function normalizePrivateKey(input: string): string {
  let s = input.trim().toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  if (!/^[0-9a-f]{64}$/.test(s)) throw new InvalidKeyError();
  const n = BigInt(`0x${s}`);
  if (n === 0n || n >= CURVE_ORDER) throw new InvalidKeyError();
  return s;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Bitcoin-alphabet base58; each leading zero byte becomes a leading '1'.
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = BASE58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  return '1'.repeat(zeros) + out;
}

// Derived from @stardust-collective/dag4-keystore 2.8.1 (MIT licence; package.json author: "Frank Fox";
// the package ships no LICENSE file), getDagAddressFromPublicKey.
export function deriveAddress(hex: string): string {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(hex, 'hex');
  const pkcsPrefix = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
  const der = Buffer.concat([pkcsPrefix, ecdh.getPublicKey(null, 'uncompressed')]);
  const hash = base58Encode(crypto.createHash('sha256').update(der).digest());
  const end = hash.slice(-36);
  const sum = [...end].reduce((acc, c) => (c >= '0' && c <= '9' ? acc + Number(c) : acc), 0);
  return `DAG${sum % 9}${end}`;
}

export function validatePassword(password: string): true | string {
  if (!/^[\x20-\x7e]{8,}$/.test(password)) {
    return 'Use at least 8 characters, printable ASCII only (letters, digits, symbols, spaces).';
  }
  return true;
}

pkijs.setEngine('node', new pkijs.CryptoEngine({name: 'node', crypto: crypto.webcrypto as unknown as Crypto}));
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export async function buildP12(hex: string, password: string): Promise<Buffer> {
  const ecdh = crypto.createECDH('secp256k1'); ecdh.setPrivateKey(hex, 'hex');
  const sec1 = Buffer.from(`30740201010420${hex}a00706052b8104000aa144034200${ecdh.getPublicKey('hex', 'uncompressed')}`, 'hex');
  const priv = crypto.createPrivateKey({key: sec1, format: 'der', type: 'sec1'});
  const pub = crypto.createPublicKey(priv);

  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({valueHex: ab(Buffer.concat([Buffer.from([1]), crypto.randomBytes(7)]))});
  const dn = () => [
    new pkijs.AttributeTypeAndValue({type: '2.5.4.3', value: new asn1js.Utf8String({value: 'constellationnetwork.io'})}),
    new pkijs.AttributeTypeAndValue({type: '2.5.4.10', value: new asn1js.Utf8String({value: 'Constellation Labs'})}),
  ];
  cert.issuer.typesAndValues = dn();
  cert.subject.typesAndValues = dn();
  cert.notBefore.value = new Date();
  cert.notAfter = new pkijs.Time({type: 1, value: new Date(Date.now() + 365000 * 864e5)});
  cert.subjectPublicKeyInfo = new pkijs.PublicKeyInfo({schema: asn1js.fromBER(ab(pub.export({format: 'der', type: 'spki'}) as Buffer)).result});
  const alg = () => new pkijs.AlgorithmIdentifier({algorithmId: '1.2.840.10045.4.3.4'}); // ecdsa-with-SHA512
  cert.signature = alg();
  cert.signatureAlgorithm = alg();
  const tbs = Buffer.from(cert.encodeTBS().toBER(false));
  cert.tbsView = new Uint8Array(tbs);
  cert.signatureValue = new asn1js.BitString({valueHex: ab(crypto.sign('sha512', tbs, priv))});

  const certDer = Buffer.from(cert.toSchema(true).toBER(false));
  const attrs = () => [
    new pkijs.Attribute({type: '1.2.840.113549.1.9.20', values: [new asn1js.BmpString({value: 'alias'})]}),
    new pkijs.Attribute({type: '1.2.840.113549.1.9.21', values: [new asn1js.OctetString({valueHex: ab(crypto.createHash('sha1').update(certDer).digest())})]}),
  ];

  const pkcs8 = new pkijs.PrivateKeyInfo();
  pkcs8.version = 0;
  pkcs8.privateKeyAlgorithm = new pkijs.AlgorithmIdentifier({algorithmId: '1.2.840.10045.2.1', algorithmParams: new asn1js.ObjectIdentifier({value: '1.3.132.0.10'})});
  pkcs8.privateKey = new asn1js.OctetString({valueHex: ab(sec1)});

  const pw = ab(Buffer.from(password, 'utf8'));
  const enc = {password: pw, contentEncryptionAlgorithm: {name: 'AES-CBC', length: 256}, hmacHashAlgorithm: 'SHA-256', iterationCount: 100000} as any; // type-only cast: pkijs typings demand an iv; its code generates one
  const keyBag = new pkijs.PKCS8ShroudedKeyBag({parsedValue: pkcs8});
  await keyBag.makeInternalValues(enc);

  const pfx = new pkijs.PFX({parsedValue: {integrityMode: 0, authenticatedSafe: new pkijs.AuthenticatedSafe({parsedValue: {safeContents: [
    {privacyMode: 1, value: new pkijs.SafeContents({safeBags: [new pkijs.SafeBag({bagId: '1.2.840.113549.1.12.10.1.3', bagValue: new pkijs.CertBag({parsedValue: cert}), bagAttributes: attrs()})]})},
    {privacyMode: 0, value: new pkijs.SafeContents({safeBags: [new pkijs.SafeBag({bagId: '1.2.840.113549.1.12.10.1.2', bagValue: keyBag, bagAttributes: attrs()})]})},
  ]}})}});
  await pfx.parsedValue!.authenticatedSafe!.makeInternalValues({safeContents: [enc, {}]});
  await pfx.makeInternalValues({password: pw, iterations: 100000, pbkdf2HashAlgorithm: 'SHA-256', hmacHashAlgorithm: 'SHA-256'});
  return Buffer.from(pfx.toSchema().toBER(false));
}
