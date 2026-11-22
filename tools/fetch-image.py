#!/usr/bin/env python3
"""Build a `docker load`-compatible tarball (docker-archive) from Docker Hub for linux/amd64.

For old NAS Docker engines (e.g. TerraMaster TOS 3 / Docker 17.05) that cannot pull modern
OCI images or verify Docker Hub's TLS chain. Usage:
    python3 tools/fetch-image.py tailscale/tailscale v1.104.7 ts.tar
    cat ts.tar | ssh nas docker load
"""
import hashlib, io, json, sys, tarfile, urllib.request

repo, tag, out = sys.argv[1], sys.argv[2], sys.argv[3]
def get(url, token=None, accept=None):
    r = urllib.request.Request(url)
    if token: r.add_header('Authorization', f'Bearer {token}')
    if accept: r.add_header('Accept', accept)
    return urllib.request.urlopen(r).read()
tok = json.loads(get(f'https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull'))['token']
base = f'https://registry-1.docker.io/v2/{repo}'
acc_idx = 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json'
acc_man = 'application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
m = json.loads(get(f'{base}/manifests/{tag}', tok, acc_idx + ',' + acc_man))
if 'manifests' in m:
    d = [x for x in m['manifests'] if x.get('platform', {}).get('architecture') == 'amd64' and x['platform'].get('os') == 'linux'][0]['digest']
    m = json.loads(get(f'{base}/manifests/{d}', tok, acc_man))
cfg = get(f"{base}/blobs/{m['config']['digest']}", tok)
cfg_name = hashlib.sha256(cfg).hexdigest() + '.json'
with tarfile.open(out, 'w') as t:
    def add(name, data):
        ti = tarfile.TarInfo(name); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
    add(cfg_name, cfg)
    layers = []
    for i, l in enumerate(m['layers']):
        blob = get(f"{base}/blobs/{l['digest']}", tok)
        assert hashlib.sha256(blob).hexdigest() == l['digest'].split(':')[1], 'digest mismatch'
        name = f"layer{i}/layer.tar"  # gzip-compressed; docker load detects compression
        add(name, blob); layers.append(name)
        print(f"layer {i}: {len(blob)//1024} KiB", file=sys.stderr)
    add('manifest.json', json.dumps([{'Config': cfg_name, 'RepoTags': [f'{repo}:{tag}'], 'Layers': layers}]).encode())
print(out)
