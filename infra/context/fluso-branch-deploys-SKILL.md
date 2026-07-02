---
name: fluso-branch-deploys
description: "Disambiguate and execute the two 'branch deploy' flavors for fluso-frontend + premapp-backend. Use when someone says 'branch deploy', 'preview stack', 'run this branch on the box', 'test PR X on hetzner', 'spin up branch Y', or mentions *.local-pcci.org or preview.nfraops.com URLs. Flavor 1 is a lightweight box instance managed by the `wt` CLI (worktrees + port block + rendered env + cloudflared hostnames on *.local-pcci.org). Flavor 2 is the formal git branch deploy: GitHub Actions builds 7 docker images and Ansible provisions a full compose stack on the AWS branch-deploy host with preview.nfraops.com URLs."
---

# Fluso branch deploys — two flavors, one phrase

| | 1 · Box instance (`wt`) | 2 · Git branch deploy (GH Actions) |
|---|---|---|
| For | interactive dev, issue workflows, screenshots, QA | shareable full-stack preview, migration/health verification |
| Where | this Hetzner box, host processes + shared docker deps | AWS branch-deploy EC2, per-branch docker compose |
| URLs | `https://<slug>{,-api,-agents}.local-pcci.org` | `https://{api,agents,chrono}-<slug>.preview.nfraops.com` |
| Speed | seconds–minutes (first FE build is the slow part) | ~15–25 min (7 image builds + provision) |
| Trigger | `wt create` + `wt start` | `gh workflow run` (or push to `branch-deploy` branch) |

**Decision rule:** "run/test/look at branch X" → flavor 1. "branch deploy" / "preview
stack" / "deploy my branch" → flavor 2. Ambiguous → ask.

## Flavor 1 — box instance

```bash
wt create mything --branch feat/my-thing        # worktrees from the branch, port block,
                                                # rendered .env.local files, deps, hostnames
wt start mything                                # deps → migrations → BE → agents → FE → health
wt url mything                                  # the three public URLs
wt status                                       # everything running + free slots
wt stop mything && wt destroy mything           # teardown (frees slot + hostnames)
```

Notes:
- Slots are limited (3): destroy instances you're done with.
- `--with chronograph` on `wt start` if the task needs the chronograph pipeline.
- Env values come from managed templates; fix URL/CORS drift with `wt env <slug>`, never
  by editing `.env.local`.

## Flavor 2 — git branch deploy

```bash
cd /home/omni/repos/premapp-backend
gh workflow run "Create Branch Deploy Artifacts" --ref <branch>   # perform_deploy defaults true
gh run list --workflow "Create Branch Deploy Artifacts" -L 1      # grab the run id
gh run watch <run-id>
```

What it does: builds all 7 images (backend, backend-runner, agents, agents-runtime, bot,
chronograph, infra) → ghcr.io; writes `.env.aws` from secrets; Ansible provisions the
compose stack at `~/compose-branch/<branch>` on the AWS host (SHA1-deterministic ports,
migrations, seed, health checks per the deployment contract).

Verify, then report these to the human:
```
https://api-<slug>.preview.nfraops.com/v1/health
https://agents-<slug>.preview.nfraops.com/healthz
https://chrono-<slug>.preview.nfraops.com/health
```
(`<slug>` = branch name lowercased, non-alnum → `-`.) A failed deploy can be retried with
the "Deploy Branch Deploy Artifacts" workflow, passing the create-run's ID. FE previews:
Vercel builds every branch and points non-main branches at
`https://<sanitized-branch>.staging-api.fluso.ai/v1`.

## Traps

| Symptom | Cause → fix |
|---|---|
| Box FE OOM / build killed | dev/turbopack mode → `wt start` uses `next build`+`next start`; don't run `pnpm dev` |
| Login bounces to localhost | `HOSTNAME` env not set on FE process → `wt stop`+`wt start` (never `-H`) |
| `/auth/me` CORS errors | FE origin missing in `SERVER_CORS_ALLOWED_ORIGINS` → `wt env <slug>` + restart |
| Composio/agent tools 404 | FE `AGENTS_SERVER_URL` points at another instance's port → `wt env <slug>` |
| Intermittent 404 on new hostname | stale cloudflared connector → `wt`'s ingress helper kills it; re-run `wt create` |
| OAuth callback → localhost:8000 | Old docs mention `SERVER_MCP_OAUTH_CALLBACK_BASE_URL` — it no longer exists; callbacks derive from the request host. Check `SERVER_REDIRECT_URI_BASE` instead |
| `gh workflow run` 404 | wrong repo cwd — the workflows live in premapp-backend (FE has its own pair) |
