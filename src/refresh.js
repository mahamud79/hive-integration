import { loadTokens, saveTokens } from './tokens.js';

const { HIVE_CLIENT_ID, HIVE_CLIENT_SECRET, HIVE_TOKEN_URL } = process.env;

// Exchange the stored (single-use) refresh token for a fresh access token.
// Hive ROTATES refresh tokens: each refresh returns a NEW refresh token that
// we must persist, or the next refresh will fail and force re-authorization.
export async function refreshTokens() {
  const current = await loadTokens();
  if (!current.refresh_token) {
    throw new Error('No refresh_token stored. Run "npm run authorize" again.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: HIVE_CLIENT_ID,
    client_secret: HIVE_CLIENT_SECRET,
  });

  const res = await fetch(HIVE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      'Token refresh failed (' + res.status + '): ' + text +
      ' - the refresh token may be expired/consumed. Run "npm run authorize" to re-authorize.'
    );
  }

  return await saveTokens(JSON.parse(text));
}

// Allow running directly: `npm run refresh`
if (import.meta.url === `file://${process.argv[1]}`) {
  refreshTokens()
    .then((t) => console.log('Refreshed. New access token valid until', new Date(t.expires_at).toISOString()))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
