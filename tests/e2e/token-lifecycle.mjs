// Credential lifetime, for the oidc overlay started with a short token TTL:
//   DEVIDP_TOKEN_TTL=25 docker compose -f docker-compose.yml \
//     -f docker-compose.oidc.yml up -d
//   tests/e2e/run.sh token-lifecycle
//
// Covers refresh-token rotation and the rule that makes long-lived sockets
// safe: a connection whose token has expired is closed on its next message,
// rather than living on because the handshake once succeeded.
import { ORIGIN, WS_ORIGIN, done, ok, sleep } from './lib.mjs'

const TTL = Number(process.env.DEVIDP_TOKEN_TTL ?? 25)

const tokenCall = async (body) => {
  const res = await fetch(`${ORIGIN}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  return { status: res.status, body: await res.json() }
}

// --- Refresh grant with single-use rotation.
const first = await tokenCall(
  'grant_type=password&username=alice&password=alice123&client_id=warroomlive-web')
ok(typeof first.body.refresh_token === 'string', 'the token response carries a refresh_token')
ok(first.body.expires_in <= 60,
  `the IdP is running with a short TTL for this suite (expires_in=${first.body.expires_in}s)`)

const renewed = await tokenCall(
  `grant_type=refresh_token&refresh_token=${first.body.refresh_token}&client_id=warroomlive-web`)
// Two tokens minted in the same second are byte-identical (same iat), so the
// rotated refresh_token — not the JWT string — is what proves freshness.
ok(renewed.status === 200 && !!renewed.body.access_token
  && renewed.body.refresh_token !== first.body.refresh_token,
  'the refresh grant issues a fresh token pair')

const replayed = await tokenCall(
  `grant_type=refresh_token&refresh_token=${first.body.refresh_token}&client_id=warroomlive-web`)
ok(replayed.status === 400, 'a spent refresh token cannot be replayed (rotation)')

// --- Per-message expiry: connect, outlive the TTL, then speak.
const ws = new WebSocket(`${WS_ORIGIN}/ws/signal?access_token=${renewed.body.access_token}`)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error('handshake with a fresh token was rejected'))
})
const joined = await new Promise((resolve) => {
  ws.onmessage = (ev) => { if (JSON.parse(ev.data).type === 'peers') resolve(true) }
  ws.send(JSON.stringify({ type: 'join', room: 'ttl-room', from: 'alice-ttl', payload: 'Alice' }))
  setTimeout(() => resolve(false), 5000)
})
ok(joined, 'an authenticated join works while the token is fresh')

console.log(`   (waiting ${TTL + 5}s for the access token to expire…)`)
const closeEvent = new Promise((resolve) => { ws.onclose = resolve })
await sleep((TTL + 5) * 1000)
ws.send(JSON.stringify({ type: 'chat', room: 'ttl-room', from: 'alice-ttl', payload: 'too late' }))
const closed = await Promise.race([closeEvent, sleep(5000).then(() => null)])
ok(closed?.code === 4401,
  `the stale connection is closed with 4401 on its next message (got ${closed?.code})`)

const again = await tokenCall(
  'grant_type=password&username=alice&password=alice123&client_id=warroomlive-web')
const reconnect = new WebSocket(`${WS_ORIGIN}/ws/signal?access_token=${again.body.access_token}`)
ok(await new Promise((resolve) => {
  reconnect.onopen = () => resolve(true)
  reconnect.onerror = () => resolve(false)
}), 'a renewed token reconnects immediately')
reconnect.close()

done('TOKEN-LIFECYCLE')
