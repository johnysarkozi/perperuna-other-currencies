"""Obtain Shopify Admin API access tokens via the client_credentials grant.

Reads SHOPIFY_<CC>_SHOP / _CLIENT_ID / _CLIENT_SECRET from the environment.
"""

import json
import os
import sys
import urllib.request

SHOPS = [c.strip().upper() for c in os.environ.get("SHOPIFY_SHOPS", "").split(",") if c.strip()]


def env(cc, key):
    val = os.environ.get(f"SHOPIFY_{cc}_{key}")
    if not val:
        raise SystemExit(f"missing SHOPIFY_{cc}_{key}")
    return val


def fetch_token(cc):
    shop = env(cc, "SHOP")
    payload = json.dumps({
        "grant_type": "client_credentials",
        "client_id": env(cc, "CLIENT_ID"),
        "client_secret": env(cc, "CLIENT_SECRET"),
    }).encode()
    req = urllib.request.Request(
        f"https://{shop}/admin/oauth/access_token",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


if __name__ == "__main__":
    codes = [a.upper() for a in sys.argv[1:]] or SHOPS
    for cc in codes:
        status, body = fetch_token(cc)
        if isinstance(body, dict) and "access_token" in body:
            tok = body["access_token"]
            print(f"{cc}: HTTP {status} token_len={len(tok)} prefix={tok[:8]} "
                  f"scope={body.get('scope')} expires_in={body.get('expires_in')}")
        else:
            print(f"{cc}: HTTP {status} {body}")
