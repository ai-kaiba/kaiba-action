# Kaiba build & deploy — GitHub Action

Build an app image to your Kaiba registry and deploy it to your dev environment.

This action wraps the [`@kaiba-cloud/cli`](https://www.npmjs.com/package/@kaiba-cloud/cli)
published on npm.

## Usage

Store a scoped Kaiba **deploy token** (org Settings → Deploy tokens) as the repo
secret `KAIBA_API_TOKEN`.

```yaml
name: Deploy to Kaiba
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: ai-kaiba/kaiba-action@v1
        with:
          command: build
          repo: ${{ github.server_url }}/${{ github.repository }}
          branch: ${{ github.sha }}
          image: web            # image name in your registry
          tag: ${{ github.sha }}
          service: web          # compose service to redeploy (chains after build)
          git-token: ${{ secrets.GITHUB_TOKEN }}   # for a private clone
          api-token: ${{ secrets.KAIBA_API_TOKEN }}
```

## Inputs

| Input | For | Description |
|---|---|---|
| `command` | all | `build`, `deploy`, or `status` |
| `api-token` | all | Scoped Kaiba deploy token (use a secret) |
| `hub-url` | all | Hub URL. Default `https://cloud.kaiba.ai` |
| `cli-version` | all | `@kaiba-cloud/cli` version to run |
| `repo` / `branch` | build | Git repo + ref to build (must be pushed) |
| `image` | build/deploy | Image name (build) or full image ref (deploy) |
| `tag` | build | Image tag — pass the commit SHA |
| `dockerfile` / `context` | build | Defaults `Dockerfile` / `.` |
| `git-token` | build | Token for a private clone |
| `service` | deploy | Compose service to retarget (build chains a deploy) |

## Commands

- **build** — build a pushed git ref and push the image. Add `service:` to roll it out in one step.
- **deploy** — retarget one compose service to an image and wait for it to run.
- **status** — print the environment's services and their live state.
