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

## Without Tailscale: Caddy

A tailnet is the recommendation because it needs no open port and no certificate of your own. If you would
rather use a public hostname, any reverse proxy that terminates TLS and forwards to `127.0.0.1:8787` works. Do
**not** publish port 8787 itself, and pass the hostname you will use with `--expose` — the runtime checks Host
and Origin *before* it checks the token, so a name it has not been told about is refused.

`/etc/caddy/Caddyfile`:

```caddyfile
workbench.example.com {
    # Caddy gets the certificate itself. The workbench stays on loopback and is never published.
    reverse_proxy 127.0.0.1:8787

    # The token is in the URL fragment, which never reaches a server — but the logs still see paths, and a
    # workspace's paths are its content. Keep them off.
    log {
        output discard
    }
}
```

Then run the container with the port bound to loopback only, and tell the runtime its public name:

```yaml
# compose.yaml, replacing the network_mode: host block
services:
  workbench:
    ports: ['127.0.0.1:8787:8787']
    command: ['start', '--bind', '0.0.0.0', '--expose', 'workbench.example.com']
```

`--bind 0.0.0.0` binds inside the container's own network namespace; the published port is loopback-only, so
the only way in is through Caddy. The bearer token is still required on every request: TLS and a hostname are
not authentication.

## Without Docker: systemd

On a machine where you would rather run Node directly:

```ini
# /etc/systemd/system/workbench.service
[Unit]
Description=AI Workbench
After=network-online.target

[Service]
Type=simple
User=workbench
WorkingDirectory=/opt/ai-workbench
Environment=WORKBENCH_WORKSPACE=/var/lib/workbench
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/cli.js start
Restart=on-failure
RestartSec=5

# The workspace holds the keys and the whole history. Nothing else on the machine needs to reach it.
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/var/lib/workbench

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now workbench
sudo journalctl -u workbench | grep '#token='
```

On a Mac, the same thing is a launchd agent in `~/Library/LaunchAgents/com.example.workbench.plist` with
`ProgramArguments` of `/usr/local/bin/node`, `dist/cli.js`, `start`, and `RunAtLoad` true. Either way, put the
sandbox on the service's `PATH` — without Deno the execute tier is switched off, and `workbench doctor` will
tell you so.

## On Windows: at logon, with Task Scheduler

The workbench runs natively on Windows — no WSL2, no Visual Studio (see the install note in the README) — and
the way to keep it running is a scheduled task that starts at logon. A Windows *service* is the wrong shape
here: a service runs as `SYSTEM` or a service account, and the workspace, the credentials file and its ACL all
belong to **you**. A logon task runs as you, which is what the file protection is written against.

```powershell
# From the repository, once. Adjust the paths.
$node = (Get-Command node).Source
$repo = "C:\Users\you\ai-workbench"
$ws   = "C:\Users\you\wb"

schtasks /create /tn "AI Workbench" /sc onlogon /rl limited `
  /tr "`"$node`" `"$repo\dist\cli.js`" start --workspace `"$ws`"" /f
```

`/rl limited` is deliberate: nothing here wants elevation, and a task running elevated would create workspace
files owned by the administrators group rather than by you.

- **The token.** `start` prints the tokened URL on stdout, and a scheduled task has nowhere to print. Read it
  from the workspace instead — `data/runtime.token` holds it, and the address is in `data/runtime.json`:
  ```powershell
  $rt = Get-Content "$ws\data\runtime.json" | ConvertFrom-Json
  "http://127.0.0.1:$($rt.port)/#token=$(Get-Content "$ws\data\runtime.token")"
  ```
  Both files are restricted to your account; `workbench doctor` says so, and says how to fix it if they are not.
- **No firewall prompt.** The runtime binds `127.0.0.1`, so Windows never asks to allow it through the
  firewall. If you see that dialog, something is binding a public address — check `--bind`.
- **Stopping it.** `schtasks /end /tn "AI Workbench"`, or Ctrl-C if you started it in a terminal. Ctrl-C and
  Ctrl-Break both shut it down cleanly. An outside kill does not — Windows has no SIGTERM, so no handler runs —
  and what it leaves behind is a stale `data/runtime.json`, which the next command notices and removes.
- **Reaching it from the phone** works exactly as above: join the machine to your tailnet, `tailscale serve`,
  and pass the tailnet hostname to `--expose`. The runtime is never exposed directly on Windows either.
- **The sandbox.** Deno is a devDependency, so a clone that ran `npm ci` already has it; a global install works
  too. Without it the execute tier is switched off by name, and `workbench doctor` tells you which tools.
