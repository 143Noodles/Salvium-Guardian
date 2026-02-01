# Salvium Guardian

Automated 3rd party escrow for the Salvium bounty board. Runs as a 2-of-3 multisig participant.

## What This Does

You're running an automated escrow service. It's a 2-of-3 multisig where:

- **Bounty Server** - holds 1 key
- **Worker** - holds 1 key (in their browser)
- **Guardian (You)** - holds 1 key

Any 2 can sign:
- Server + Worker = normal payout (work completed)
- Server + Guardian = refund if worker abandons
- Worker + Guardian = dispute resolution

## Requirements

- Docker & Docker Compose
- A domain with HTTPS (via Cloudflare Tunnel, nginx, Caddy, etc.)
- Port 3012 accessible to your reverse proxy

## Quick Start

### 1. Clone and configure

```bash
git clone <repo-url>
cd Salvium-Guardian

# Set your wallet password
cp .env.example .env
nano .env  # Change WALLET_PASSWORD to something secure
```

### 2. Set up HTTPS access (choose one)

**Option A: Cloudflare Tunnel (recommended)**

```bash
# Install cloudflared and create tunnel
cloudflared tunnel create guardian
cloudflared tunnel route dns guardian guardian.yourdomain.com

# Copy your credentials
cp ~/.cloudflared/<tunnel-id>.json tunnel/credentials.json

# Configure routing
cp tunnel/config.yml.example tunnel/config.yml
nano tunnel/config.yml  # Update tunnel ID and hostname
```

**Option B: Use your own reverse proxy**

Remove the tunnel service from `docker-compose.yml` and point your nginx/Caddy/traefik at `localhost:3012`.

Add to docker-compose.yml under guardian service:
```yaml
ports:
  - "3012:3012"
```

### 3. Start

```bash
docker compose up -d
```

### 4. Verify

```bash
curl https://guardian.yourdomain.com/health
# Should return: {"status":"ok","initialized":true,...}
```

### 5. Notify the bounty board admin

Let them know your Guardian URL so they can configure the bounty server to use it.

## Your Responsibilities

1. Keep this running
2. Don't lose your `.env` password
3. That's it - everything else is automatic

## Commands

```bash
# View logs
docker compose logs -f guardian

# Check status
curl http://localhost:3012/health

# Restart
docker compose restart

# Update
git pull
docker compose up -d --build
```

## Manual Intervention (CLI)

If you need to manually check or intervene:

```bash
# Guardian status
docker exec salvium-guardian node cli.js status

# List all bounties
docker exec salvium-guardian node cli.js bounties

# Show bounty details
docker exec salvium-guardian node cli.js bounty <bounty-id>

# Export guardian seed (for emergencies only!)
docker exec salvium-guardian node cli.js export-seed

# Export bounty wallet seed
docker exec salvium-guardian node cli.js export-bounty-seed <bounty-id>

# Manual refund signing (after deadline)
docker exec salvium-guardian node cli.js sign-refund <bounty-id>
```

## Backup

Save these:
1. Your `.env` file (password)
2. The data volume: `docker cp salvium-guardian:/data ./backup`

## Security Notes

- Private keys stay in the container, never exposed via API
- Only signs refunds AFTER the deadline passes (automatic check)
- Fully automated - no manual approvals needed for normal operation
- The CLI is for emergencies/disputes only

## Files

```
.env                    # Your password (create from .env.example)
tunnel/config.yml       # Cloudflare tunnel routing (if using)
tunnel/credentials.json # Cloudflare tunnel auth (if using)
data/                   # Bounty state (auto-created, persisted in Docker volume)
```
