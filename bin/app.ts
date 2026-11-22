#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { HeadscaleStack } from '../lib/headscale-stack';

const app = new App();

// Personal settings live in an untracked config.local.json (see config.example.json).
// Anything passed with `-c key=value` wins over the file.
const configFile = app.node.tryGetContext('configFile') ?? path.join(__dirname, '..', 'config.local.json');
if (fs.existsSync(configFile)) {
  const fileCtx = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  for (const [k, v] of Object.entries(fileCtx)) {
    if (app.node.tryGetContext(k) === undefined) app.node.setContext(k, v);
  }
}

const config = loadConfig(app.node);

new HeadscaleStack(app, app.node.tryGetContext('stackName') ?? 'Headscale', {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Self-hosted Tailscale control plane: Headscale + Headplane on Lightsail, Cognito OIDC',
});
