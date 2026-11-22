/**
 * Pinned container images. Bump ONE minor version at a time (see README "Upgrades").
 * Verified against GitHub releases / registries on 2026-11-22.
 */
export const IMAGES = {
  /** https://github.com/juanfont/headscale/releases/tag/v0.29.7 (Docker Hub tag has no "v") */
  headscale: 'headscale/headscale:0.29.7',
  /** https://github.com/tale/headplane/releases/tag/v0.8.2 */
  headplane: 'ghcr.io/tale/headplane:0.8.2',
  /** https://hub.docker.com/_/caddy */
  caddy: 'caddy:2.11.9-alpine',
} as const;
