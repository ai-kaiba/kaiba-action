# Kaiba build & deploy — GitHub Action

Build an app image to your Kaiba registry and deploy it to your dev environment.

This action **bundles** the Kaiba CLI (`dist/`) and runs it directly — no npm,
no `npx`, no network install.

## Auth

Store a scoped Kaiba **deploy token** (org Settings → Deploy tokens) as the repo
secret `KAIBA_API_TOKEN`.

## Kaiba builds the image

```yaml
- uses: ai-kaiba/kaiba-action@v1
  with:
    command: build
    repo: ${{ github.server_url }}/${{ github.repository }}
    branch: ${{ github.sha }}
    image: web
    tag: ${{ github.sha }}
    service: web            # chains a deploy after the build
    git-token: ${{ secrets.GITHUB_TOKEN }}
    api-token: ${{ secrets.KAIBA_API_TOKEN }}
```

## GitHub builds the image, Kaiba deploys it

`registry-login` logs Docker in to your Kaiba registry and reports the push
prefix as the `registry-url` output — you never hardcode the registry.

```yaml
- id: kaiba
  uses: ai-kaiba/kaiba-action@v1
  with:
    command: registry-login
    api-token: ${{ secrets.KAIBA_API_TOKEN }}
- uses: docker/build-push-action@v6
  with:
    push: true
    tags: ${{ steps.kaiba.outputs.registry-url }}/web:${{ github.sha }}
- uses: ai-kaiba/kaiba-action@v1
  with:
    command: deploy
    service: web
    image: ${{ steps.kaiba.outputs.registry-url }}/web:${{ github.sha }}
    api-token: ${{ secrets.KAIBA_API_TOKEN }}
```

## Commands

- **build** — build a pushed git ref on Kaiba and push the image. Add `service:` to roll it out.
- **deploy** — retarget one compose service to an image and wait for it to run.
- **registry-login** — `docker login` to your Kaiba registry; exposes `registry-url`.
- **status** — print the environment's services and their live state.

## Outputs

| Output | Description |
|---|---|
| `registry-url` | The registry push prefix (set by `registry-login`). Append `/<image>:<tag>`. |
