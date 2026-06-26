import crypto from 'node:crypto';

// base64url encoding (no padding, URL-safe) as required by PKCE (RFC 7636)
function base64url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// A high-entropy cryptographic random string, 43-128 chars.
export function createCodeVerifier() {
  return base64url(crypto.randomBytes(64));
}

// code_challenge = BASE64URL(SHA256(code_verifier)), method S256
export function createCodeChallenge(codeVerifier) {
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  return base64url(hash);
}

// Opaque value to protect against CSRF on the OAuth callback
export function createState() {
  return base64url(crypto.randomBytes(16));
}
