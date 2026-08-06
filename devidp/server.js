// ⚠ DEV-ONLY OpenID Connect provider — NOT for production. ⚠
//
// A ~200-line stand-in for a real IdP (Keycloak / Entra ID / Auth0) so the OIDC
// overlay can run and be tested anywhere. It implements just enough of the spec
// for this stack: discovery, JWKS, the authorization-code flow with PKCE (S256),
// and the password grant for headless tests. Fixed plaintext test users, no
// consent, no sessions, in-memory signing key (tokens die with the process).
//
// The rest of the system speaks standard OIDC and does not know this exists:
// point the OIDC_* env vars at a real provider to replace it.
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

const port = Number(process.env.PORT ?? 8089)
const issuer = (process.env.ISSUER ?? `http://localhost:${port}/auth`).replace(/\/$/, '')
const basePath = new URL(issuer).pathname // e.g. "/auth"
const tokenTtlSeconds = Number(process.env.TOKEN_TTL_SECONDS ?? 1800)

const USERS = {
  alice: { password: 'alice123', name: 'Alice Chen' },
  bob: { password: 'bob123', name: 'Bob Lin' },
}

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'devidp', alg: 'RS256', use: 'sig' }

/** code → { sub, nonce, redirectUri, codeChallenge, clientId, expiresAt } */
const codes = new Map()

async function signToken(claims, audience) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'devidp' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + tokenTtlSeconds)
    .sign(privateKey)
}

async function tokenResponse(sub, clientId, nonce) {
  const user = USERS[sub]
  const identity = { sub, preferred_username: sub, name: user.name }
  return {
    access_token: await signToken({ ...identity, scope: 'openid profile' }, 'warroomlive'),
    id_token: await signToken(nonce ? { ...identity, nonce } : identity, clientId),
    token_type: 'Bearer',
    expires_in: tokenTtlSeconds,
    scope: 'openid profile',
  }
}

const loginPage = (query, error = '') => `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>WarRoomLive 開發登入</title>
<style>
  body{font-family:system-ui;background:#0d1117;color:#e6e8eb;display:grid;place-items:center;min-height:100vh;margin:0}
  form{background:#12151b;border:1px solid #2a2f38;border-radius:10px;padding:2rem;width:280px}
  h1{font-size:1.1rem;margin:0 0 1rem}
  input{width:100%;box-sizing:border-box;margin:.25rem 0 .75rem;padding:.5rem .65rem;border:1px solid #2a2f38;border-radius:6px;background:#171a21;color:inherit}
  button{width:100%;padding:.55rem;border:0;border-radius:6px;background:#3b82f6;color:#fff;cursor:pointer}
  .err{color:#f87171;font-size:.85rem}.hint{color:#9aa0a6;font-size:.75rem;margin-top:1rem}
</style></head><body>
<form method="post" action="${basePath}/authorize?${query}">
  <h1>WarRoomLive 開發登入</h1>
  ${error ? `<p class="err">${error}</p>` : ''}
  <label>帳號 <input name="username" autofocus></label>
  <label>密碼 <input name="password" type="password"></label>
  <button type="submit">登入</button>
  <p class="hint">僅供開發:alice/alice123、bob/bob123</p>
</form></body></html>`

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(new URLSearchParams(data)))
  })

createServer(async (req, res) => {
  const url = new URL(req.url, issuer)
  const route = `${req.method} ${url.pathname.replace(basePath, '') || '/'}`
  try {
    switch (route) {
      case 'GET /.well-known/openid-configuration':
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'password'],
          code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['RS256'],
          subject_types_supported: ['public'],
          scopes_supported: ['openid', 'profile'],
        })

      case 'GET /jwks':
        return json(res, 200, { keys: [jwk] })

      case 'GET /authorize':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(loginPage(url.searchParams.toString()))

      case 'POST /authorize': {
        const form = await readBody(req)
        const username = form.get('username') ?? ''
        if (USERS[username]?.password !== form.get('password')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          return res.end(loginPage(url.searchParams.toString(), '帳號或密碼錯誤'))
        }
        const code = randomUUID()
        codes.set(code, {
          sub: username,
          nonce: url.searchParams.get('nonce'),
          redirectUri: url.searchParams.get('redirect_uri'),
          codeChallenge: url.searchParams.get('code_challenge'),
          clientId: url.searchParams.get('client_id'),
          expiresAt: Date.now() + 60_000,
        })
        const target = new URL(url.searchParams.get('redirect_uri'))
        target.searchParams.set('code', code)
        if (url.searchParams.get('state')) target.searchParams.set('state', url.searchParams.get('state'))
        res.writeHead(302, { location: target.toString() })
        return res.end()
      }

      case 'POST /token': {
        const form = await readBody(req)
        if (form.get('grant_type') === 'password') {
          const username = form.get('username') ?? ''
          if (USERS[username]?.password !== form.get('password')) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'bad credentials' })
          }
          return json(res, 200, await tokenResponse(username, form.get('client_id') ?? 'warroomlive-web', null))
        }
        if (form.get('grant_type') !== 'authorization_code') {
          return json(res, 400, { error: 'unsupported_grant_type' })
        }
        const grant = codes.get(form.get('code'))
        codes.delete(form.get('code'))
        if (!grant || grant.expiresAt < Date.now()) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'unknown or expired code' })
        }
        const digest = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
        if (digest !== grant.codeChallenge) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
        }
        if (form.get('redirect_uri') !== grant.redirectUri) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
        }
        return json(res, 200, await tokenResponse(grant.sub, grant.clientId, grant.nonce))
      }

      default:
        return json(res, 404, { error: 'not_found' })
    }
  } catch (err) {
    console.error('devidp error:', err)
    return json(res, 500, { error: 'server_error' })
  }
}).listen(port, () => {
  console.log(`devidp (DEV ONLY) listening on :${port}, issuer ${issuer}`)
})
