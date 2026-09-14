# Deploying the Loom relay

The relay gives a hub that can only dial out an address like `https://work.relay.furevikstrand.cloud`. It forwards TLS it cannot open (ADR-0014): the certificate for that name belongs to the hub.

## 1. DNS

Two records pointing at the VPS:

```
relay.furevikstrand.cloud.     A     <VPS IPv4>
*.relay.furevikstrand.cloud.   A     <VPS IPv4>
```

(and `AAAA` records if the VPS has IPv6).

## 2. The relay's own certificate

Only for `relay.furevikstrand.cloud` itself, used by hubs to reach the relay. Not a wildcard: a wildcard on the VPS would let the VPS impersonate hubs.

```sh
sudo certbot certonly --standalone -d relay.furevikstrand.cloud        # port 80 free for a moment
sudo install -d -o loom-relay /etc/loom-relay
sudo install -m 600 -o loom-relay /etc/letsencrypt/live/relay.furevikstrand.cloud/fullchain.pem /etc/loom-relay/relay.crt
sudo install -m 600 -o loom-relay /etc/letsencrypt/live/relay.furevikstrand.cloud/privkey.pem /etc/loom-relay/relay.key
```

Add a certbot deploy hook that repeats the two `install` lines and runs `systemctl reload loom-relay`.

## 3. Install and start

Needs Node 24 on the VPS.

```sh
npm run bundle -w @loom/relay                          # on your machine: relay/dist/loom-relay.mjs
scp relay/dist/loom-relay.mjs relay/deploy/* vps:/tmp/
# on the VPS:
sudo useradd --system --home /var/lib/loom-relay --shell /usr/sbin/nologin loom-relay
sudo install -d /opt/loom-relay && sudo install -m 644 /tmp/loom-relay.mjs /opt/loom-relay/
sudo install -m 644 /tmp/relay.example.json /etc/loom-relay/relay.json      # edit the domain
sudo install -m 644 /tmp/loom-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now loom-relay
```

If nginx already uses 80 and 443, see `nginx.conf.example`.

## 4. Enroll a hub

```sh
sudo -u loom-relay node /opt/loom-relay/loom-relay.mjs add-hub work --config /etc/loom-relay/relay.json
```

It prints a `relay` block with a one-time secret. Put it in that hub's `hub.json` and restart the hub. The hub dials out, gets its certificate from Let's Encrypt through the relay, and logs `relay up`. Then add `https://work.relay.furevikstrand.cloud` in any Loom client with the hub's token.

## 5. Close the certificate gap (recommended)

The relay answers port 80 for hub names, so a compromised VPS could get its own certificate for a hub name. The hub logs `CAA accounturi: <url>`; pin issuance to that account in DNS (the zone is not on the VPS):

```
work.relay.furevikstrand.cloud.  CAA  0 issue "letsencrypt.org; accounturi=<url>"
```

`remove-hub` stops a hub from registering again; a connected hub stays until its connection drops or the relay restarts.
