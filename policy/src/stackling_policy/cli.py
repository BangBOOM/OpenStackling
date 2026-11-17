import argparse
import importlib
import ipaddress
import json
import os

import uvicorn

from .server import create_app


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--profile", required=True)
    serve.add_argument("--factory", required=True)
    serve.add_argument("--policy-id", default=None)
    serve.add_argument("--model-revision", default=None)
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--origin", action="append", default=[])
    serve.add_argument("--handshake-timeout", type=float, default=30)
    args = parser.parse_args()
    token = os.environ.get("STACKLING_POLICY_TOKEN", "")
    try:
        loopback = ipaddress.ip_address(args.host).is_loopback
    except ValueError:
        loopback = args.host == "localhost"
    if not loopback and (not token or not args.origin):
        parser.error("LAN binding requires STACKLING_POLICY_TOKEN and --origin")
    if args.handshake_timeout <= 0:
        parser.error("Timeout must be positive")
    if not args.policy_id or not args.model_revision:
        parser.error("Custom policies require --policy-id and --model-revision")
    module, factory = args.factory.split(":", 1)
    policy = getattr(importlib.import_module(module), factory)()
    with open(args.profile) as f:
        profile = json.load(f)
    app = create_app(
        profile,
        policy,
        args.policy_id,
        args.model_revision,
        token,
        args.origin,
        args.handshake_timeout,
    )
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        ws_max_size=128 * 1024 * 1024,
        ws_max_queue=2,
    )
