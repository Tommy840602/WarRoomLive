// Authentication enforcement on both WebSocket planes, for the oidc overlay:
//   docker compose -f docker-compose.yml -f docker-compose.oidc.yml up -d
//   tests/e2e/run.sh oidc
//
// The point is symmetry — signaling and collab must both refuse anonymous and
// forged credentials, and both must work with a real token from the IdP.
import { ORIGIN, RUN_ID, WS_ORIGIN, collabClient, done, ok, signalClient, sleep, until } from './lib.mjs'

const DOC = 'warroom:oidc-' + RUN_ID

// The dev IdP supports the password grant so the suite needs no browser.
const tokenRes = await fetch(`${ORIGIN}/auth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=password&username=alice&password=alice123&client_id=warroomlive-web',
})
const { access_token: token } = await tokenRes.json()
ok(typeof token === 'string' && token.split('.').length === 3, 'obtained a JWT from the IdP')

// --- Signaling plane.
{
  const handshake = (query) => new Promise((resolve) => {
    const ws = new WebSocket(`${WS_ORIGIN}/ws/signal${query}`)
    ws.onopen = () => { ws.close(); resolve('accepted') }
    ws.onerror = () => resolve('rejected')
  })

  ok(await handshake('') === 'rejected', 'signaling handshake without a token is rejected')
  ok(await handshake('?access_token=eyJhbGciOiJub25lIn0.e30.') === 'rejected',
    'signaling handshake with a forged token is rejected')

  const authed = signalClient('alice-1', 'Alice', { token })
  const peers = await authed.join('oidc-' + RUN_ID)
  ok(peers.type === 'peers', 'an authenticated join succeeds')
  authed.close()
}

// --- Collab plane.
{
  let authFailed = false
  const forged = await collabClient(DOC, { token: 'not-a-real-jwt' })
  forged.provider.on('authenticationFailed', () => { authFailed = true })
  await until('forged token rejected', () => authFailed, 15000)
  ok(!forged.provider.isSynced, 'collab rejects a forged token')
  forged.destroy()

  // Without a token the server never opens the sync session, so no document
  // content ever reaches the client — it simply idles.
  const anon = await collabClient(DOC)
  await sleep(5000)
  ok(!anon.provider.isSynced && anon.text.toString() === '',
    'an unauthenticated collab connection never syncs and receives no content')
  anon.destroy()

  const a = await collabClient(DOC, { token })
  const b = await collabClient(DOC, { token })
  await until('both synced', () => a.provider.isSynced && b.provider.isSynced, 15000)
  a.text.insert(0, 'authed-sync')
  await until('replicated', () => b.text.toString() === 'authed-sync')
  ok(true, 'authenticated collab clients sync normally')
  a.destroy()
  b.destroy()
}

done('OIDC')
