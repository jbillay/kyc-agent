# Quickstart: Docker Compose Stack

**Branch**: `001-docker-compose-stack` | **Date**: 2026-04-08

Use this guide to verify the implementation is correct after building the feature.

## Prerequisites

- Docker Desktop 4.x+ or Docker Engine 24+ with Compose V2
- 16 GB RAM, 8 CPU cores, 50 GB free disk
- Git (to clone the repo)

## Validation Steps

### Step 1: Cold Start

```bash
# From repo root — clean slate
docker-compose down -v 2>/dev/null || true
docker-compose up -d

# Wait ~60s then check all services
docker-compose ps
```

**Expected**: All services show `running` or `healthy`. No service shows `Exited` or
`Restarting`.

### Step 2: Verify Health Checks

```bash
# PostgreSQL health
docker-compose exec postgres pg_isready -U kyc -d kycagent

# Redis health
docker-compose exec redis redis-cli ping

# API health
curl -s http://127.0.0.1:4000/health
```

**Expected**: `pg_isready` prints `/var/run/postgresql:5432 - accepting connections`;
`redis-cli ping` returns `PONG`; API health returns HTTP 200.

### Step 3: Verify Networking (Service-to-Service DNS)

```bash
docker-compose exec api wget -q -O- http://minio:9000/minio/health/live
docker-compose exec agent-worker wget -q -O- http://ollama:11434/
```

**Expected**: Both succeed — no "connection refused" or DNS errors.

### Step 4: Verify MinIO Bucket

```bash
# Access MinIO console
open http://127.0.0.1:9001   # (or browse manually)
# Login: minioadmin / minioadmin
# Verify "documents" bucket exists
```

**OR via CLI:**

```bash
docker-compose exec api node -e "
const Minio = require('minio');
const c = new Minio.Client({endPoint:'minio',port:9000,useSSL:false,accessKey:'minioadmin',secretKey:'minioadmin'});
c.bucketExists('documents',(e,r)=>console.log('exists:',r));
"
```

**Expected**: `exists: true`

### Step 5: Verify .env Override

```bash
# Add an override
echo "API_PORT=4001" >> .env
docker-compose up -d api

# Check new port works
curl -s http://127.0.0.1:4001/health

# Restore
sed -i '/API_PORT=4001/d' .env
docker-compose up -d api
```

**Expected**: API responds on port 4001 after restart; original port 4000 is no longer bound.

### Step 6: Persistence Test

```bash
# Write a test row to postgres
docker-compose exec postgres psql -U kyc -d kycagent -c \
  "INSERT INTO users(id, email, role) VALUES (gen_random_uuid(), 'test@example.com', 'analyst') ON CONFLICT DO NOTHING;"

# Restart without volume removal
docker-compose restart postgres

# Verify row survived
docker-compose exec postgres psql -U kyc -d kycagent -c \
  "SELECT email FROM users WHERE email = 'test@example.com';"
```

**Expected**: The row is returned after restart.

### Step 7: On-Failure Restart Test

```bash
# Kill the API process inside the container (simulates a crash)
docker-compose exec api kill 1

# Wait 5s and check it restarted
sleep 5
docker-compose ps api
```

**Expected**: API container shows `running` with restart count > 0.

### Step 8: Clean Teardown

```bash
docker-compose down -v
docker volume ls | grep kyc  # Should return nothing
docker-compose ps            # Should return nothing
```

**Expected**: No volumes or containers remain.

### Step 9: Development Override Test

```bash
# Start with override (automatic when docker-compose.override.yml is present)
docker-compose up -d

# Edit a frontend file and verify HMR triggers in browser (no rebuild needed)
# Edit a backend file and verify nodemon reloads the process
docker-compose logs api | grep -i "restarting\|watching"
```

**Expected**: Code changes are reflected without `docker-compose up --build`.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Port already in use | Host port conflict | Override port in `.env` |
| API exits immediately | Postgres not ready yet | Increase `postgres` healthcheck retries; check `docker-compose logs postgres` |
| MinIO bucket missing | API didn't run bucket init | Check `docker-compose logs api` for MinIO errors |
| Ollama not responding | Model not yet pulled | Pull a model: `docker-compose exec ollama ollama pull mistral` |
| Services accessible from network | `_HOST` set to `0.0.0.0` | Revert to `127.0.0.1` or ensure credentials are changed |
