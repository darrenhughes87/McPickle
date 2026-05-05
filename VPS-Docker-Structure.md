# VPS Docker Structure — Hostinger

> ⚠️ The old VPS-Info.md says Nginx. **It is not Nginx.** It is Traefik. This is the correct reference.

---

## The Big Picture

All apps run as Docker containers. **Traefik** sits in front of everything — it handles:
- HTTP → HTTPS redirects
- SSL certificates (Let's Encrypt, automatic)
- Routing requests to the right container based on domain name

You never touch Nginx. You never touch Certbot manually. Traefik does it all via labels in each app's `docker-compose.yml`.

---

## Directory Structure

```
/docker/
├── n8n/                  ← Traefik lives here (started with n8n)
│   └── docker-compose.yml
├── pivotalpeople/        ← PivotalPeople app
│   ├── docker-compose.yml
│   └── .env
├── wheresyabin/          ← Where's Ya Bin? app
│   ├── docker-compose.yml
│   └── .env
└── pilister/
    └── cloud/
        └── docker-compose.yml
```

Each app gets its own folder under `/docker/`. Clone the repo there, add a `.env`, done.

---

## Ports In Use

| App | Internal Port |
|-----|--------------|
| PivotalPeople | 3001 |
| Where's Ya Bin? | 3002 |
| n8n | 5678 |
| cloud-pilister | 5000 |

Pick the next free port for a new app. **Do not expose ports to the host** (no `ports:` mapping needed) — Traefik talks to containers directly over the Docker network.

---

## The Shared Network

All apps must join the **`n8n_default`** network so Traefik can reach them. Every `docker-compose.yml` needs this at the bottom:

```yaml
networks:
  traefik:
    external: true
    name: n8n_default
```

And the service itself needs:
```yaml
    networks:
      - default
      - traefik
```

---

## How Traefik Knows About Your App

You add labels to your service in `docker-compose.yml`. These tell Traefik: what domain, what port, use SSL. Copy this block and change the three `myapp` references and the domain:

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.myapp.rule=Host(`mydomain.com`) || Host(`www.mydomain.com`)
      - traefik.http.routers.myapp.entrypoints=web,websecure
      - traefik.http.routers.myapp.tls=true
      - traefik.http.routers.myapp.tls.certresolver=mytlschallenge
      - traefik.http.services.myapp.loadbalancer.server.port=3003
      - traefik.docker.network=n8n_default
```

Traefik picks this up automatically when the container starts — no config files to edit, no reloads needed.

---

## Adding a New App — Checklist

1. **Buy domain** (Namecheap or Hostinger) — domain only, no hosting
2. **Point DNS A records** (`@` and `www`) to VPS IP: `187.77.177.208`
3. **Clone repo** into `/docker/myapp/`
4. **Create `.env`** with `nano /docker/myapp/.env`
5. **Update `docker-compose.yml`** with correct Traefik labels and network
6. **`docker compose up -d --build`** — Traefik auto-issues SSL cert once DNS is live

That's it. No nginx. No certbot. No manual SSL.

---

## Checking DNS Before Starting

DNS must be pointing at the VPS before you start the container, otherwise Let's Encrypt can't issue the SSL cert. Check with:

```bash
dig +short mydomain.com @8.8.8.8
```

Should return `187.77.177.208`. If blank, wait a few minutes and try again.

---

## Useful Commands

```bash
# See all running containers
docker ps

# Logs for a specific app
docker logs wheresyabin

# Rebuild and restart an app after a git pull
cd /docker/myapp && git pull && docker compose up -d --build

# Check how many subscribers in a SQLite app (no sqlite3 CLI in container)
docker exec myapp node -e "
import('better-sqlite3').then(({default:DB})=>{
  const db=new DB('/app/data/myapp.db');
  console.log(db.prepare('SELECT COUNT(*) as n FROM subscribers').get());
})"

# VPS IPv4 address
curl -s -4 ifconfig.me
```

---

## Environment Variables

Each app has a `.env` file in its `/docker/myapp/` folder. The `docker-compose.yml` passes these to the container via the `environment:` block using `${VAR_NAME}` syntax. The `.env` file is **never committed to GitHub** (it's in `.gitignore`). A `.env.example` with empty values lives in the repo instead.

---

## Tech Stack (standard pattern across apps)

- **Runtime**: Node 22 + Express
- **Database**: better-sqlite3 (SQLite, data persisted in Docker named volume)
- **Container**: Docker + docker-compose
- **Routing/SSL**: Traefik (automatic, label-based)
- **Updates**: `git pull && docker compose up -d --build`
