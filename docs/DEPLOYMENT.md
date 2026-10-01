# Deployment Boundary

## Status

This document describes how a Driftless Phase 2 deployment is expected to be built and secured. It is configuration guidance, not a record of a deployment: whether any deployment existed, and what it was, is recorded only in a qualification record such as [PHASE2_QUALIFICATION.md](PHASE2_QUALIFICATION.md). Host names below use the reserved `example.org` and `example` domains; they are placeholders, not Driftless hosts.

Nothing here changes the Phase 2A–2C security controls. Plain `ws://` remains a loopback development exception only.

## Topology

```text
                 HTTPS / WSS (TCP 443)
browser ───────────────────────────────▶ TLS reverse proxy ──▶ static files (apps/web/dist)
                                            │
                                            ├─ /v1/signaling ─▶ signaling service, 127.0.0.1:8787 (WebSocket)
                                            └─ /healthz ──────▶ signaling service, 127.0.0.1:8787

browser ── STUN / TURN (UDP 3478, TCP 3478, TLS 5349, relay UDP range) ──▶ TURN server (coturn)
browser ◀──────────────── WebRTC data channel, direct or via TURN ─────────────────▶ browser
```

- The web client and the signaling service share one origin. The browser derives `wss://<its host>/v1/signaling` from its own `https` origin, and the build's Content Security Policy (`default-src 'self'`) admits exactly that socket. No other origin is contacted, except the STUN and TURN servers the ICE configuration names, which WebRTC reaches outside the CSP.
- The signaling service binds to loopback and is reached only through the proxy. It never receives media.
- The TURN server is a separate process, possibly on another host, sharing only the TURN secret with the signaling service.

## Build

From a clean checkout of the exact revision to deploy:

```sh
npm ci
DRIFTLESS_BUILD_REVISION="$(git rev-parse HEAD)" npm run build
```

- `DRIFTLESS_BUILD_REVISION` is shown under **Connection diagnostics → Build**, so evidence can name the deployed revision. It must be a lowercase hexadecimal commit hash; an unset value shows `unversioned`.
- `VITE_RTC_STUN_URLS` (optional) adds up to four `stun:`/`stuns:` URLs to the build. Prefer configuring STUN on the service instead (`SIGNALING_STUN_URLS`), which needs no rebuild.
- `VITE_RTC_ICE_TRANSPORT_POLICY=relay` produces a **qualification-only** build in which every peer connection uses TURN relay candidates only. It is never the production default; see [Forced-relay qualification builds](#forced-relay-qualification-builds).
- Never put a TURN credential, TURN secret, or any other secret in a `VITE_*` variable: every such value is published in the JavaScript bundle. The browser obtains TURN credentials at run time from the signaling service.

The web output is `apps/web/dist/`; the service output is `services/signaling/dist/` with `node_modules` from `npm ci` (runtime dependencies: `ws` and the workspace `@driftless/protocol`).

## Signaling service

Run `node services/signaling/dist/main.js` (or `npm run start -w @driftless/signaling`) as an unprivileged user, with configuration from the environment or a service manager's environment file, never from a committed file. Example (placeholders):

```sh
NODE_ENV=production
SIGNALING_HOST=127.0.0.1
SIGNALING_PORT=8787
SIGNALING_ALLOWED_ORIGINS=https://driftless.example.org
SIGNALING_STUN_URLS=stun:turn.example.org:3478
SIGNALING_TURN_URLS=turn:turn.example.org:3478?transport=udp,turns:turn.example.org:5349?transport=tcp
SIGNALING_TURN_SECRET_FILE=/run/secrets/driftless-turn-secret
SIGNALING_TURN_CREDENTIAL_TTL_SECONDS=3600
```

- `NODE_ENV=production` requires `SIGNALING_ALLOWED_ORIGINS`, accepts only exact `https` origins, and never accepts `*` or `null`. List only the deployed application origin (and, temporarily, a qualification origin).
- `SIGNALING_TURN_SECRET_FILE` names a file readable only by the service user (mode `0600`) holding the TURN shared secret: 32–512 characters of printable ASCII without spaces. One trailing newline is ignored. `SIGNALING_TURN_SECRET` is accepted instead where a platform injects secrets only as environment variables; setting both is refused. Neither value is ever logged, and a configuration error never echoes it.
- Without `SIGNALING_TURN_URLS`, the service still answers `RTC_CONFIG_REQUEST`, with only the configured STUN servers (possibly none). Browsers then connect without TURN, and diagnostics say **TURN configuration: Not configured**.
- The full variable list, with defaults and bounds, is in [`services/signaling/README.md`](../services/signaling/README.md).

## Reverse proxy and TLS

The proxy terminates TLS with a publicly trusted certificate, serves the static files, and forwards `/v1/signaling` and `/healthz` to the service. It must:

- upgrade WebSocket connections on `/v1/signaling` (HTTP/1.1 `Upgrade`/`Connection` headers);
- forward the browser's `Origin` header unchanged, because the service's origin policy checks it;
- keep the WebSocket open longer than the service's ping interval (15 s by default); an idle timeout of 60 s or more is enough, because the service's pings keep the connection active;
- redirect `http` to `https` and never serve the application or signaling over plain HTTP or `ws://`;
- not rewrite the path or add a query string (the service refuses any query on the upgrade).

The service does not read `X-Forwarded-For`, `X-Forwarded-Proto`, or any other forwarded header, and makes no IP-based decision, so no proxy header needs to be trusted. Connection counts and rate limits apply per WebSocket connection.

The proxy should add these response headers to the static files (the build's meta-tag CSP cannot express `frame-ancestors`):

```text
Strict-Transport-Security: max-age=31536000
Content-Security-Policy: default-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

`sw.js` should be served with `Cache-Control: no-cache` so service-worker updates are noticed. Access logs never contain room credentials: no credential is ever placed in a URL.

Example Caddy site (Caddy obtains the certificate itself, upgrades WebSockets, and forwards `Origin` unchanged):

```text
driftless.example.org {
	@signaling path /v1/signaling /healthz
	handle @signaling {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		root * /srv/driftless/web
		file_server
		header Strict-Transport-Security "max-age=31536000"
		header Content-Security-Policy "default-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		header X-Content-Type-Options nosniff
		header Referrer-Policy no-referrer
		header Permissions-Policy "camera=(), microphone=(), geolocation=()"
	}
	@sw path /sw.js
	header @sw Cache-Control no-cache
}
```

Equivalent nginx location for the signaling path:

```text
location = /v1/signaling {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```

## TURN server (coturn)

Driftless uses the TURN REST shared-secret credential scheme ([ADR-0007](adr/0007-ephemeral-turn-credentials.md)). coturn supports it with `use-auth-secret`. A minimal configuration (placeholders; the secret is written into the server's own configuration or secret file at deployment time and never committed):

```text
listening-port=3478
tls-listening-port=5349
realm=turn.example.org
fingerprint
use-auth-secret
static-auth-secret=<the same secret as SIGNALING_TURN_SECRET_FILE>
cert=/etc/ssl/turn.example.org/fullchain.pem
pkey=/etc/ssl/turn.example.org/privkey.pem
min-port=49160
max-port=49200
user-quota=4
total-quota=100
no-cli
no-multicast-peers
no-tlsv1
no-tlsv1_1
# Never relay into private, loopback, link-local, or carrier-grade NAT ranges.
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
```

- Set `external-ip` if the server sits behind NAT.
- `user-quota` limits concurrent allocations per username. Driftless usernames carry one stable pseudonym per room membership, so the quota applies per participant. The mechanism cannot scope a credential to one room; see the ADR's consequences.
- Firewall: open TCP 443 (proxy), UDP and TCP 3478, TCP 5349, and the relay UDP range; never expose the signaling port.
- Generate the secret with a cryptographic generator, for example `openssl rand -base64 48`, and install it in both places through the host's secret store or files readable only by the service users. Rotation means installing a new secret in both and restarting them; outstanding credentials stop working.
- coturn logs TURN usernames: an expiry and a pseudonymous label, never the participant ID or credential. Keep its logs short-lived.
- STUN can be served by the same coturn (`stun:turn.example.org:3478`) so that no third-party STUN service is a dependency.

## Forced-relay qualification builds

A qualification of TURN must show that the relay actually carries the data channel. Build a separate bundle with `VITE_RTC_ICE_TRANSPORT_POLICY=relay` and `DRIFTLESS_BUILD_REVISION` set, and serve it at a separate origin (for example a separate host name), adding that origin to `SIGNALING_ALLOWED_ORIGINS` for the duration of the test. The diagnostics show **ICE transport policy: Relay only (qualification build)**. Without a TURN server in the service's configuration, such a build fails each peer connection at once with "This build allows only relayed connections, and no relay server was available." and stops after the bounded recoveries. Remove the origin and the build after the test. A relay build must never replace the normal build.

## Deployment smoke test

Before any real-device test, from a browser on an outside network:

1. `https://<host>/` loads with a valid certificate and no mixed-content warning; the response carries the headers above.
2. `https://<host>/healthz` returns `{"status":"ok"}` and nothing else.
3. Creating a room opens one `wss://<host>/v1/signaling` socket with no query string; the DevTools console shows no CSP violation and no error.
4. A second browser joins with the room ID and invite secret; the address bar of both never contains them.
5. **Connection diagnostics** show the expected build revision and **TURN configuration** (`Available` when TURN is configured).
6. The service log contains only its fixed events: no secret, credential, identifier, address, or payload.

## Qualification on a development host

The Phase 2D qualification used a development host instead of the topology above: an account-free Cloudflare quick tunnel to a Vite preview server on the development machine, which served the build and forwarded the signaling paths ([PHASE2_QUALIFICATION.md](PHASE2_QUALIFICATION.md#deployment)). Such a topology differs from a deployment in ways a qualification must record: TLS belongs to the tunnel provider; the tunnel also serves plain HTTP without redirecting (the client then refuses to open rooms, as it does on any non-loopback HTTP page); the origin is a development server; and the signaling service runs on one participant's machine, so disrupting that machine's network also disrupts signaling — a recovery test there must disrupt the other device's network only. It cannot host a TURN server reachable from other networks.

## Not covered

Monitoring, alerting, TURN bandwidth caps and cost controls, abuse response, multi-instance signaling (rooms are in memory in one process), backups (there is no persistent state), and release procedures are not designed in Phase 2. A service restart ends every room.
