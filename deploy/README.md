# Deploy: single EC2 box

Target: one Ubuntu 22.04 EC2 instance behind `live.slop.computer` and
`media.slop.computer`, HTTPS via Caddy, MediaMTX for RTMP→HLS.

## One-time host setup

```bash
# install Node 20 + yarn + Caddy
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# MediaMTX
curl -L https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_linux_amd64.tar.gz | sudo tar -xz -C /usr/local/bin mediamtx
```

Open ports 80, 443, 22, 1935 (RTMP) in the security group.

DNS: `live.slop.computer` and `media.slop.computer` A-records → elastic IP.

## Deploy the app

```bash
cd /home/ubuntu
git clone https://github.com/clawdbotatg/slop-computer-live.git
cd slop-computer-live
yarn install
cp packages/nextjs/.env.example packages/nextjs/.env.local
cp packages/relay/.env.example packages/relay/.env
yarn next:build
yarn relay:build
yarn browser:build
```

The browser-host pulls a Chromium build into `~/.cache/puppeteer` on first
install — about 250 MB. Make sure the EC2 instance has `--no-sandbox`-friendly
deps installed:

```bash
sudo apt-get install -y libnss3 libatk-bridge2.0-0 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0
```

## Wire up Caddy + systemd

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

sudo cp deploy/slop-live.service /etc/systemd/system/
sudo cp deploy/slop-relay.service /etc/systemd/system/
sudo cp deploy/slop-browser-host.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now slop-live slop-relay slop-browser-host
```

## Updating

```bash
cd /home/ubuntu/slop-computer-live
git pull
yarn install
yarn next:build && yarn relay:build && yarn browser:build
sudo systemctl restart slop-live slop-relay slop-browser-host
```

## Notes

- HTTPS is required for `getUserMedia` / `getDisplayMedia`. Caddy handles certs.
- Relay state is in-memory; restarting drops sessions and requires a re-SIWE.
- For TURN, start with Cloudflare Calls (free tier) before self-hosting `coturn`.
