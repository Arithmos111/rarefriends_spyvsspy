# Deploying Embassy Run

Embassy Run needs a long-lived process, not static hosting. The relay holds lobbies and live
matches in memory and talks to players over a WebSocket, and that WebSocket **must share an
origin with the game page**, because FriendSDK's sandbox allows `connect-src 'self'` and the
Rare Friends RPC and nothing else. One machine serves both. You cannot put the static files on
a CDN or GitHub Pages and the relay somewhere else; the browser will refuse the connection.

TLS is also not optional. Browser wallets need a secure context and `wss://` needs HTTPS, so
**a bare IP address will not work.** You need a domain name.

Two paths below. Both use the same container.

---

## Hostinger VPS

Works on any KVM plan. KVM 1 is already generous: measured load is 14% of one core and about
150 MB of memory at 120 concurrent players, and its 4 TB of monthly traffic is roughly 33,000
player-hours at the ~32 KiB/s per player this game uses.

**Hostinger's shared and cloud web hosting will not work,** even though it runs Node.js apps.
Shared plans apply per-account connection limits and resource controls, and every player here
holds one open socket for a whole match. It may survive two people testing and fall over in
front of an audience.

### 1. Point a domain at the machine

In your DNS (Hostinger's hPanel if the domain lives there), add an `A` record for the hostname
players will visit, pointing at the VPS IPv4 address. Add an `AAAA` record too if the VPS has
IPv6. Wait for it to resolve before going further, or certificate issuance will fail:

```sh
dig +short embassy.example.com
```

**If the domain is on Cloudflare, set the record to "DNS only" (grey cloud) before deploying.**
With the orange cloud on, Cloudflare terminates TLS itself and you hit a chicken-and-egg:
Cloudflare expects a certificate on the origin, and the origin is trying to obtain one through
Cloudflare. A proxied record also resolves to Cloudflare's addresses rather than the VPS, so
`dig` will not return your server's IP and nothing you deploy will be reachable.

You can turn the proxy back on afterwards if you want it, and its WebSocket support is fine for
this game. Do it in this order: grey cloud, deploy, confirm Caddy holds a real certificate, then
enable the orange cloud and set SSL/TLS mode to **Full (strict)**. That works because the origin
now has a valid public certificate. Never attempt it before the first successful deploy.

Registrar "domain forwarding" or a Cloudflare redirect rule will **not** work. Those issue an
HTTP redirect from someone else's server and never deliver traffic to yours. You need a real
A record.

### 2. Create the VPS

In hPanel choose a KVM plan and, under the operating system, pick the **Ubuntu with Docker**
template if it is offered. That saves installing Docker yourself. Plain Ubuntu 24.04 is fine
too; step 4 covers it.

### 3. Open the firewall

In hPanel under your VPS, open the firewall settings and allow inbound **22** (SSH), **80** and
**443** (TCP, and UDP 443 if you want HTTP/3). Port 80 is required: Caddy uses it for the
certificate challenge and to redirect visitors to HTTPS.

### 4. Install Docker, if the template did not

```sh
ssh root@YOUR_VPS_IP
curl -fsSL https://get.docker.com | sh
docker compose version
```

Something else may already hold ports 80 and 443, which stops Caddy binding them. Check first:

```sh
ss -lntp | grep -E ':80|:443'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

That must come back empty. Two common causes:

- **Hostinger's Docker template deploys Traefik**, a reverse proxy, and leaves it running. Remove
  it from hPanel's Docker Manager with the **⋮** menu, or from the shell:

  ```sh
  cd "$(docker inspect traefik-traefik-1 --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')"
  docker compose down
  ```

  Keeping Traefik and adapting to it is possible in principle, since it can also issue
  certificates, but its configuration varies by template and the Caddy stack here is the tested
  path.

- **A plain Ubuntu image with Apache or nginx preinstalled:**

  ```sh
  systemctl disable --now apache2 nginx 2>/dev/null || true
  ```

**Do not deploy through hPanel's Docker Manager UI.** "Compose manually" and "Compose from URL"
paste a compose file into a directory of Hostinger's choosing, with no repository checked out
beside it. This stack builds its image from the repository source and bind-mounts `Caddyfile`,
so both the build context and that file would be missing. Use the shell.

### 5. Deploy

hPanel's **Web console** is a fine alternative to SSH and needs no key set up. One quirk: it can
mangle multi-line pastes, inserting the bracketed-paste markers `^[[200~` and `^[[201~` as
literal text and producing errors like `cd: command not found`. Turn that off first, or paste one
line at a time:

```sh
bind 'set enable-bracketed-paste off'
```

```sh
git clone https://github.com/Arithmos111/rarefriends_spyvsspy.git
cd rarefriends_spyvsspy
git checkout claude/spy-vs-spy-multiplayer-ggby0m

cp .env.example .env
nano .env          # set DOMAIN to the hostname from step 1

docker compose up -d --build
```

The first build fetches and compiles FriendSDK from its pinned commit, so on a single vCPU
expect **five to ten minutes**. Later builds reuse cached layers and are much faster.

### 6. Check it

```sh
docker compose ps                  # both services should be running
docker compose logs -f caddy       # watch the certificate being issued
curl -I https://embassy.example.com
```

Then open the site in a browser with your wallet, connect, select your Friend and create a
lobby. Open it on a second device to confirm two agents meet in one match.

### 7. Running it day to day

```sh
docker compose logs -f game        # relay activity: lobbies created, matches started
docker compose restart game        # restart the relay only
docker compose down                # stop everything
```

Updating to a newer commit:

```sh
git pull
docker compose up -d --build
```

**A restart or redeploy ends every match in progress,** because match state lives in memory.
There is no draining. Deploy between sessions, not mid-event.

Keep the `caddy_data` volume. It holds your certificates, and destroying it forces re-issuance
against Let's Encrypt's rate limits.

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Caddy logs a certificate failure | DNS is not resolving to this machine yet, or port 80 is blocked or occupied. Re-check steps 1, 3 and 4. |
| `dig` returns addresses that are not your VPS | The record is proxied through Cloudflare, or it is a forwarding/redirect rule rather than an A record. See step 1. |
| Caddy will not start, port already allocated | Traefik from Hostinger's Docker template, or a preinstalled Apache or nginx. See step 4. |
| Repeated certificate failures, then refusals | Let's Encrypt rate-limits failed validations at five per hostname per hour. Stop Caddy, fix DNS, then start again rather than letting it retry into the limit. |
| `^[[200~` appears in your commands | The web console's bracketed paste. See step 5. |
| Page loads, but the header reads "Relay offline" | The WebSocket is not reaching the relay. Confirm both containers are up, and that nothing but Caddy sits in front of the domain. |
| Wallet will not connect | The site is being served over plain HTTP, or by IP address. Wallets require HTTPS on a real hostname. |
| Build is killed partway | Out of memory on a small plan. Add swap: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`. |
| Players time out after a few minutes | A proxy or CDN in front of Caddy is closing idle connections. Cloudflare's proxy is fine for WebSockets, but confirm it is enabled for the record. |

---

## Fly.io

Less setup, TLS handled for you, and `fly.toml` is already in the repository.

```sh
fly launch --no-deploy --copy-config   # choose your own app name
fly deploy
fly secrets set RF_GENESIS_ADDRESS=0x...   # optional
```

`fly.toml` deliberately pins one always-on machine with `auto_stop_machines = false`. Do not
raise the machine count: a second instance serves a second, disconnected lobby list. Scale the
machine up instead.

Bandwidth is billed per gigabyte rather than included, at roughly $0.02/GB in North America and
Europe, which works out near $0.0008 for a full four-player match. For light use Fly is
cheaper; past roughly 2,500 player-hours a month a flat-rate VPS wins.

---

## Sizing, measured

Synthetic clients speaking the real protocol against the real relay:

| Load | CPU | Memory | Downstream |
| --- | --- | --- | --- |
| 40 players, 10 matches | 7.6% of one core | 124 MB | 1.25 MB/s |
| 120 players, 30 matches | 14% of one core | 151 MB | 3.7 MB/s |

Snapshot delivery held at 19.7 Hz against a 20 Hz target at 120 players. Each player pulls
about 32 KiB/s, so 100 concurrent players for an hour is roughly 11 GB. CPU is not the binding
constraint; bandwidth is. If it ever matters, the lever is the snapshot, which is about 1.6 KB
and currently resends static furniture and the full scoreboard every tick.
