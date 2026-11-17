"""Abrupt client disconnects stay quiet and release the lease after cleanup."""

import asyncio
import contextlib
import io
import json
import logging
import math
import struct
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np
import uvicorn
import websockets
from PIL import Image
from support import Hold

from stackling_policy.contract import PROTOCOL, digest
from stackling_policy.server import create_app

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "protocol/fixtures.json").read_text()
)


def envelope(kind, request=1, episode=None, **fields):
    return dict(
        type=kind, sessionId="test", episodeId=episode, requestId=request, **fields
    )


class SlowObserve(Hold):
    def observe(self, observation):
        time.sleep(0.4)
        super().observe(observation)


def calibration_for(profile):
    cam = profile["config"]["camera"]
    angle = (
        ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].index(cam["position"])
        * math.pi
        / 4
    )
    p = np.array(
        [
            math.sin(angle) * cam["distance"],
            profile["config"]["environment"]["tableTop"] + cam["height"],
            -math.cos(angle) * cam["distance"],
        ]
    )
    z = p - cam["target"]
    z /= np.linalg.norm(z)
    x = np.cross([0, 1, 0], z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    matrix = np.eye(4)
    matrix[:3, :3] = np.column_stack((x, y, z))
    matrix[:3, 3] = p
    fy = cam["heightPixels"] / (2 * math.tan(math.radians(cam["fov"]) / 2))
    return {
        "width": cam["width"],
        "height": cam["heightPixels"],
        "intrinsics": [
            [fy, 0, cam["width"] / 2],
            [0, fy, cam["heightPixels"] / 2],
            [0, 0, 1],
        ],
        "cameraToWorld": matrix.flatten(order="F").tolist(),
        "position": p.tolist(),
        "target": cam["target"],
        "near": cam["near"],
        "far": cam["far"],
        "pixelOrigin": "top-left",
        "pixelCenters": "half-integers",
        "cameraAxes": "right, up, backward (Three.js); depth is positive optical-axis distance",
        "depthScaleMeters": 0.001,
        "depthInvalid": 0,
    }


def observation_packet(profile, episode, request, tick=0):
    cam = profile["config"]["camera"]
    png = io.BytesIO()
    Image.new("RGB", (cam["width"], cam["heightPixels"]), (1, 2, 3)).save(
        png, format="PNG"
    )
    rgb = png.getvalue()
    header = envelope(
        "observation",
        request,
        episode,
        tick=tick,
        time=tick / profile["config"]["environment"]["physicsHz"],
        state=[
            0,
            0,
            *profile["config"]["environment"]["robot"]["homeJoints"],
            profile["config"]["environment"]["robot"]["home"]["gap"],
            *profile["config"]["environment"]["robot"]["homeJoints"],
            profile["config"]["environment"]["robot"]["home"]["gap"],
        ],
        cameraToWorld=calibration_for(profile)["cameraToWorld"],
        rgbBytes=len(rgb),
        depthBytes=0,
    )
    encoded = json.dumps(header).encode()
    return struct.pack("<I", len(encoded)) + encoded + rgb


class ErrorCapture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.ERROR)
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


@contextlib.contextmanager
def running_server(policy):
    capture = ErrorCapture()
    logging.getLogger().addHandler(capture)
    logging.getLogger("uvicorn.error").addHandler(capture)
    config = uvicorn.Config(
        create_app(FIXTURE["profile"], policy, "hold", "1"),
        host="127.0.0.1",
        port=0,
        log_level="warning",
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started
    host, port = server.servers[0].sockets[0].getsockname()[:2]
    try:
        yield f"ws://{host}:{port}/policy", f"http://{host}:{port}/health", capture
    finally:
        server.should_exit = True
        thread.join(timeout=10)


def health(health_url):
    with urllib.request.urlopen(health_url, timeout=2) as response:
        return json.loads(response.read())


def assert_lease_released(health_url, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not health(health_url)["busy"]:
            return
        time.sleep(0.05)
    raise AssertionError("Lease was not released after disconnect")


async def connect(ws_url):
    ws = await websockets.connect(ws_url, subprotocols=[PROTOCOL])
    await ws.send(json.dumps(envelope("hello", token="")))
    reply = json.loads(await asyncio.wait_for(ws.recv(), 5))
    assert reply["type"] == "manifest"
    return ws


async def observing_client(ws_url):
    ws = await connect(ws_url)
    profile = FIXTURE["profile"]
    actual = FIXTURE["actual"]
    await ws.send(
        json.dumps(
            envelope(
                "configure",
                2,
                None,
                profileHash=digest(profile),
                configuration=profile["config"],
                configurationHash=digest(profile["config"]),
                calibration=calibration_for(profile),
            )
        )
    )
    assert json.loads(await asyncio.wait_for(ws.recv(), 5))["type"] == "configured"
    await ws.send(
        json.dumps(
            envelope(
                "episode_start",
                3,
                "ep",
                actual=actual,
                configHash=digest(actual),
            )
        )
    )
    assert json.loads(await asyncio.wait_for(ws.recv(), 5))["type"] == "episode_ready"
    await ws.send(observation_packet(profile, "ep", 4))
    await asyncio.sleep(0.1)  # The server is now inside the slow observe callback.
    ws.transport.abort()


def test_disconnect_during_callback_is_quiet_and_cleans_up():
    with running_server(SlowObserve()) as (ws_url, health_url, errors):
        asyncio.run(observing_client(ws_url))
        assert_lease_released(health_url)
        time.sleep(0.3)
        assert errors.messages == [], errors.messages
