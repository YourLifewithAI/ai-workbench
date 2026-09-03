# Deploying the workbench on a VPS (D-60)

The runtime is one process on one port, bound to `127.0.0.1`, and it is **never exposed to the public internet**. Your phone and laptop reach it over a Tailscale tailnet; `tailscale serve` adds TLS and a stable hostname. Everything private lives in one workspace directory on the VPS.

What you need: a Linux VPS (the recipe assumes Ubuntu 24.04; any Docker-capable host works), a Tailscale account, and the devices you want to use joined to the same tailnet. Full-disk encryption of the VPS is the host's job: pick a provider that offers it, or enable LUKS at install.

## 1. Docker and the code

```sh
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker "$USER" && newgrp docker
git clone https://github.com/YourLifewithAI/ai-workbench.git && cd ai-workbench
mkdir -p workspace && sudo chown 1000:1000 workspace   # the container runs as uid 1000 (node)
```

## 2. Tailscale on the host

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status            # note this machine's name, e.g. workbench.tail1234.ts.net
```

Enable HTTPS certificates for your tailnet once in the Tailscale admin console (DNS → HTTPS Certificates).

## 3. Start the workbench

```sh
export WORKBENCH_EXPOSE=workbench.tail1234.ts.net   # your tailnet hostname; the runtime accepts it as Host/Origin
docker compose up -d --build
docker compose logs workbench | grep '#token='        # the one line with the token
```

The runtime listens on `127.0.0.1:8787` of the host (`network_mode: host`). Front it with Tailscale:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Open `https://workbench.tail1234.ts.net/#token=<token from the log>` on any device in your tailnet. Add it to the iPhone Home Screen for an app-like window (push notifications arrive in RUN-12).

The token changes on every start; read it from the log again after `docker compose restart`. It is also in `workspace/data/runtime.token` (0600) for CLI use:

```sh
docker compose exec workbench node dist/cli.js runs list
docker compose exec workbench node dist/cli.js run agent echo --input "hello from the VPS" --provider mock
```

## 4. Credentials

Put provider keys in `workspace/config/credentials.json` with mode `0600`:

```json
{ "google": { "apiKey": "…" } }
```

```sh
chmod 600 workspace/config/credentials.json
docker compose restart workbench
```

Keys never leave that file except inside outbound provider calls; they are redacted from every trace, log, and API response.

## 5. Backups

The workspace directory is the whole state. Back it up like any folder, with the runtime stopped so the SQLite file is consistent:

```sh
# nightly, e.g. from cron
cd ~/ai-workbench && docker compose stop workbench && tar czf ~/backups/workspace-$(date +%F).tgz workspace && docker compose start workbench
```

Migrations also keep an online backup in `workspace/data/backups/` before changing the schema (retention: `retention.backups` in `config/workbench.json`).

## 6. Updating

```sh
git pull && docker compose up -d --build
docker compose logs workbench | grep '#token='
```

## Without Tailscale

Any reverse proxy that terminates TLS and forwards to `127.0.0.1:8787` works; pass its hostname with `--expose`. Do **not** publish port 8787 itself. A Caddy recipe arrives in RUN-11.
