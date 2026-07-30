// HTTP collector + server-side OAuth.
//
// The browser / GTM POSTs checkout data here, and this server pushes to Hive
// server-side (holding the OAuth tokens, never exposing them to the client).
//
// Local:  npm run dev    (loads .env)
// Render: npm start      (uses the platform's environment variables)

import http from 'node:http';
import { URL } from 'node:url';

import {
  createCodeVerifier,
  createCodeChallenge,
  createState,
} from './pkce.js';

import {
  saveTokens,
  tokensExist,
} from './tokens.js';

import {
  pushEvents,
  pushOrders,
} from './hive.js';

import {
  buildEventPayload,
  buildOrderPayload,
  ValidationError,
} from './order-builder.js';

const PORT = Number(
  process.env.PORT || 8787
);

const ALLOWED_ORIGINS = (
  process.env.COLLECTOR_ALLOWED_ORIGIN || '*'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const MAX_BODY_BYTES =
  256 * 1024;

const {
  HIVE_CLIENT_ID,
  HIVE_CLIENT_SECRET,
  HIVE_REDIRECT_URI,
  HIVE_AUTHORIZE_URL,
  HIVE_TOKEN_URL,
  HIVE_SCOPES,
  HIVE_TOUR_ID,
} = process.env;

/*
 * Short-lived PKCE state for the OAuth handshake.
 *
 * The /oauth/start and /oauth/callback requests must reach
 * the same running process within 10 minutes.
 */
const pkceStore = new Map();

function rememberPkce(
  state,
  verifier
) {
  const cutoff =
    Date.now() -
    10 * 60 * 1000;

  for (
    const [key, value]
    of pkceStore
  ) {
    if (value.ts < cutoff) {
      pkceStore.delete(key);
    }
  }

  pkceStore.set(
    state,
    {
      verifier,
      ts: Date.now(),
    }
  );
}

function setCors(
  res,
  reqOrigin
) {
  let allow =
    ALLOWED_ORIGINS[0] || '*';

  if (
    ALLOWED_ORIGINS.includes('*')
  ) {
    allow = '*';
  } else if (reqOrigin) {
    const cleanOrigin =
      reqOrigin.replace(
        /^https?:\/\//,
        ''
      );

    const ok =
      ALLOWED_ORIGINS.some(
        (origin) => {
          const cleanAllowed =
            origin.replace(
              /^https?:\/\//,
              ''
            );

          if (
            cleanAllowed.startsWith(
              '*.'
            )
          ) {
            const domain =
              cleanAllowed.slice(2);

            return (
              cleanOrigin === domain ||
              cleanOrigin.endsWith(
                '.' + domain
              )
            );
          }

          return (
            cleanOrigin ===
            cleanAllowed
          );
        }
      );

    if (ok) {
      allow = reqOrigin;
    }
  }

  res.setHeader(
    'Access-Control-Allow-Origin',
    allow
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, GET, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  res.setHeader(
    'Vary',
    'Origin'
  );
}

function sendJson(
  res,
  status,
  obj
) {
  res.writeHead(
    status,
    {
      'Content-Type':
        'application/json; charset=utf-8',
    }
  );

  res.end(
    JSON.stringify(obj)
  );
}

function sendHtml(
  res,
  status,
  html
) {
  res.writeHead(
    status,
    {
      'Content-Type':
        'text/html; charset=utf-8',
    }
  );

  res.end(html);
}

function readJsonBody(req) {
  return new Promise(
    (resolve, reject) => {
      let size = 0;
      const chunks = [];

      req.on(
        'data',
        (chunk) => {
          size += chunk.length;

          if (
            size >
            MAX_BODY_BYTES
          ) {
            reject(
              new ValidationError(
                'Request body too large'
              )
            );

            req.destroy();
            return;
          }

          chunks.push(chunk);
        }
      );

      req.on(
        'end',
        () => {
          const raw =
            Buffer
              .concat(chunks)
              .toString('utf8')
              .trim();

          if (!raw) {
            resolve({});
            return;
          }

          try {
            resolve(
              JSON.parse(raw)
            );
          } catch {
            reject(
              new ValidationError(
                'Invalid JSON body'
              )
            );
          }
        }
      );

      req.on(
        'error',
        reject
      );
    }
  );
}

async function exchangeCodeForTokens(
  code,
  codeVerifier
) {
  const body =
    new URLSearchParams({
      grant_type:
        'authorization_code',

      code,

      redirect_uri:
        HIVE_REDIRECT_URI,

      client_id:
        HIVE_CLIENT_ID,

      client_secret:
        HIVE_CLIENT_SECRET,

      code_verifier:
        codeVerifier,
    });

  const response =
    await fetch(
      HIVE_TOKEN_URL,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded',
        },

        body,
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      'Token exchange failed (' +
      response.status +
      '): ' +
      text
    );
  }

  return JSON.parse(text);
}

// -------------------------------------------------------
// Collector handlers
// -------------------------------------------------------

async function handleOrder(
  payload
) {
  const event =
    buildEventPayload(
      payload.event
    );

  const order =
    buildOrderPayload(
      payload
    );

  /*
   * The event must exist in Hive before the
   * ticketing order references it.
   */
  const eventRes =
    await pushEvents([
      event,
    ]);

  const orderRes =
    await pushOrders([
      order,
    ]);

  return {
    event_id:
      order.event_id,

    order_id:
      order.order_id,

    status:
      order.status,

    hive: {
      event:
        eventRes.status,

      order:
        orderRes.status,
    },
  };
}

async function handleEvent(
  payload
) {
  const event =
    buildEventPayload(
      payload.event ||
      payload
    );

  const response =
    await pushEvents([
      event,
    ]);

  return {
    event_id:
      event.event_id,

    hive: {
      event:
        response.status,
    },
  };
}

const server =
  http.createServer(
    async (
      req,
      res
    ) => {
      const requestUrl =
        new URL(
          req.url,
          'http://localhost:' +
          PORT
        );

      const reqPath =
        requestUrl.pathname;

      // -------------------------------------------------
      // OAuth start
      // -------------------------------------------------

      if (
        req.method === 'GET' &&
        reqPath ===
          '/oauth/start'
      ) {
        const missing = [];

        if (
          !HIVE_CLIENT_ID
        ) {
          missing.push(
            'HIVE_CLIENT_ID'
          );
        }

        if (
          !HIVE_REDIRECT_URI
        ) {
          missing.push(
            'HIVE_REDIRECT_URI'
          );
        }

        if (
          !HIVE_AUTHORIZE_URL
        ) {
          missing.push(
            'HIVE_AUTHORIZE_URL'
          );
        }

        /*
         * This is now mandatory.
         *
         * For the production Bingo Loco brand:
         * HIVE_TOUR_ID=135315
         */
        if (
          !HIVE_TOUR_ID
        ) {
          missing.push(
            'HIVE_TOUR_ID'
          );
        }

        if (
          missing.length
        ) {
          return sendHtml(
            res,
            500,
            '<h1>Missing OAuth config</h1>' +
            '<p>Set these Render environment variables:</p>' +
            '<pre>' +
            missing.join('\n') +
            '</pre>'
          );
        }

        const verifier =
          createCodeVerifier();

        const challenge =
          createCodeChallenge(
            verifier
          );

        const state =
          createState();

        rememberPkce(
          state,
          verifier
        );

        /*
         * URL/searchParams is safer than manually joining
         * the query string and preserves any existing
         * query parameters on HIVE_AUTHORIZE_URL.
         */
        const authorizeUrl =
          new URL(
            HIVE_AUTHORIZE_URL
          );

        authorizeUrl
          .searchParams
          .set(
            'response_type',
            'code'
          );

        authorizeUrl
          .searchParams
          .set(
            'client_id',
            HIVE_CLIENT_ID
          );

        authorizeUrl
          .searchParams
          .set(
            'redirect_uri',
            HIVE_REDIRECT_URI
          );

        authorizeUrl
          .searchParams
          .set(
            'scope',
            HIVE_SCOPES ||
            'events:write orders:write contacts:write'
          );

        authorizeUrl
          .searchParams
          .set(
            'code_challenge',
            challenge
          );

        authorizeUrl
          .searchParams
          .set(
            'code_challenge_method',
            'S256'
          );

        authorizeUrl
          .searchParams
          .set(
            'state',
            state
          );

        /*
         * Required for the initial partner grant.
         * This tells Hive which brand/tour the OAuth
         * authorization should be connected to.
         */
        authorizeUrl
          .searchParams
          .set(
            'tour_id',
            HIVE_TOUR_ID
          );

        res.writeHead(
          302,
          {
            Location:
              authorizeUrl.toString(),
          }
        );

        res.end();
        return;
      }

      // -------------------------------------------------
      // OAuth callback
      // -------------------------------------------------

      if (
        req.method === 'GET' &&
        reqPath ===
          '/oauth/callback'
      ) {
        const error =
          requestUrl
            .searchParams
            .get('error');

        const code =
          requestUrl
            .searchParams
            .get('code');

        const state =
          requestUrl
            .searchParams
            .get('state');

        if (error) {
          return sendHtml(
            res,
            400,
            '<h1>Authorization failed</h1>' +
            '<pre>' +
            error +
            '</pre>'
          );
        }

        if (!code) {
          return sendHtml(
            res,
            400,
            '<h1>Authorization failed</h1>' +
            '<p>No authorization code was returned.</p>'
          );
        }

        const entry =
          state &&
          pkceStore.get(
            state
          );

        if (!entry) {
          return sendHtml(
            res,
            400,
            '<h1>Invalid or expired state</h1>' +
            '<p>Start again at /oauth/start</p>'
          );
        }

        pkceStore.delete(
          state
        );

        try {
          const tokens =
            await exchangeCodeForTokens(
              code,
              entry.verifier
            );

          await saveTokens(
            tokens
          );

          return sendHtml(
            res,
            200,
            '<h1>Authorized!</h1>' +
            '<p>Tokens saved. The collector is ready.</p>' +
            '<p>Target Hive brand/tour: ' +
            HIVE_TOUR_ID +
            '</p>'
          );
        } catch (error) {
          return sendHtml(
            res,
            500,
            '<h1>Token exchange failed</h1>' +
            '<pre>' +
            error.message +
            '</pre>'
          );
        }
      }

      // -------------------------------------------------
      // Health/status
      // -------------------------------------------------

      if (
        req.method === 'GET' &&
        (
          reqPath ===
            '/health' ||
          reqPath === '/'
        )
      ) {
        const authorized =
          await tokensExist();

        return sendJson(
          res,
          200,
          {
            ok: true,

            authorized,

            tour_configured:
              Boolean(
                HIVE_TOUR_ID
              ),
          }
        );
      }

      // -------------------------------------------------
      // Collector endpoints
      // -------------------------------------------------

      setCors(
        res,
        req.headers.origin
      );

      if (
        req.method ===
        'OPTIONS'
      ) {
        res.writeHead(204);
        res.end();
        return;
      }

      if (
        req.method ===
          'POST' &&
        (
          reqPath ===
            '/collect/order' ||
          reqPath ===
            '/collect/event'
        )
      ) {
        try {
          const payload =
            await readJsonBody(
              req
            );

          const result =
            reqPath ===
              '/collect/order'
              ? await handleOrder(
                  payload
                )
              : await handleEvent(
                  payload
                );

          return sendJson(
            res,
            202,
            {
              accepted: true,
              ...result,
            }
          );
        } catch (error) {
          if (
            error instanceof
            ValidationError
          ) {
            return sendJson(
              res,
              422,
              {
                error:
                  'ValidationError',

                message:
                  error.message,
              }
            );
          }

          const status =
            error.status &&
            error.status >= 400 &&
            error.status < 600
              ? error.status
              : 502;

          console.error(
            'Collector error:',
            error.message,
            error.response || ''
          );

          return sendJson(
            res,
            status,
            {
              error:
                'UpstreamError',

              message:
                error.message,

              details:
                error.response ||
                null,
            }
          );
        }
      }

      return sendJson(
        res,
        404,
        {
          error:
            'NotFound',

          message:
            'Unknown route',
        }
      );
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      'Hive collector listening on port ' +
      PORT
    );

    console.log(
      '  GET  /oauth/start      authorize this server with Hive'
    );

    console.log(
      '  GET  /oauth/callback   OAuth redirect target'
    );

    console.log(
      '  POST /collect/order    status "started" = abandoned cart, "completed" = purchase'
    );

    console.log(
      '  POST /collect/event    upsert an event only'
    );

    console.log(
      '  GET  /health           { ok, authorized, tour_configured }'
    );

    console.log(
      'Allowed CORS origins: ' +
      ALLOWED_ORIGINS.join(
        ', '
      )
    );

    console.log(
      'Hive tour/brand configured: ' +
      (
        HIVE_TOUR_ID
          ? 'yes'
          : 'no'
      )
    );
  }
);
