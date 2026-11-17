import io
import json
import struct
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from support import Hold

from stackling_policy.contract import (
    PROTOCOL,
    PolicyError,
    decode_observation,
    decode_packet,
)
from stackling_policy.server import create_app

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "protocol/fixtures.json").read_text()
)


def envelope(kind, request=1, episode=None, **fields):
    return dict(
        type=kind, sessionId="test", episodeId=episode, requestId=request, **fields
    )


def hello(ws, token=""):
    ws.send_json(envelope("hello", token=token))
    return ws.receive_json()


def test_auth_origin_and_busy():
    app = create_app(
        FIXTURE["profile"],
        Hold(),
        "hold",
        "1",
        token="secret",
        origins=["http://localhost:5180"],
    )
    with TestClient(app) as client:
        with client.websocket_connect("/policy", subprotocols=[PROTOCOL]) as ws:
            assert hello(ws, "bad")["code"] == "AUTH_FAILED"
        with client.websocket_connect(
            "/policy",
            subprotocols=[PROTOCOL],
            headers={"origin": "http://evil.invalid"},
        ) as ws:
            assert hello(ws, "secret")["code"] == "AUTH_FAILED"
        with client.websocket_connect("/policy", subprotocols=[PROTOCOL]) as ws:
            assert hello(ws, "secret")["type"] == "manifest"
            assert client.get("/health").json()["busy"]
            with client.websocket_connect("/policy", subprotocols=[PROTOCOL]) as extra:
                assert hello(extra, "secret")["code"] == "SERVER_BUSY"


def test_unconfigured_episode():
    app = create_app(FIXTURE["profile"], Hold(), "hold", "1")
    with TestClient(app) as client:
        with client.websocket_connect("/policy", subprotocols=[PROTOCOL]) as ws:
            hello(ws)
            ws.send_json(
                envelope(
                    "episode_start",
                    2,
                    "e",
                    actual=FIXTURE["actual"],
                    configHash="0" * 64,
                )
            )
            assert ws.receive_json()["code"] == "INVALID_STATE"


def test_packet_sizes_and_decoding():
    png = io.BytesIO()
    Image.new("RGB", (2, 3), (10, 20, 30)).save(png, format="PNG")
    rgb = png.getvalue()
    header = envelope(
        "observation",
        2,
        "e",
        tick=0,
        time=0,
        state=[0] * 16,
        cameraToWorld=np.eye(4).flatten(order="F").tolist(),
        rgbBytes=len(rgb),
        depthBytes=0,
    )
    encoded = json.dumps(header).encode()
    packet = struct.pack("<I", len(encoded)) + encoded + rgb
    m, payload = decode_packet(packet)
    obs = decode_observation(
        m, payload, {"width": 2, "heightPixels": 3, "depth": False}
    )
    assert obs.rgb.shape == (3, 2, 3) and np.all(obs.rgb == [10, 20, 30])
    for invalid in (packet[:-1], packet + b"x", b"\xff\xff\xff\xff"):
        with pytest.raises(PolicyError):
            decode_packet(invalid)
    with pytest.raises(PolicyError):
        decode_observation(m, payload, {"width": 3, "heightPixels": 2, "depth": False})


def test_duplicate_request_is_closed():
    from starlette.websockets import WebSocketDisconnect

    app = create_app(FIXTURE["profile"], Hold(), "hold", "1")
    with TestClient(app) as client:
        with client.websocket_connect("/policy", subprotocols=[PROTOCOL]) as ws:
            hello(ws)
            ws.send_json(envelope("hello", token=""))
            with pytest.raises(WebSocketDisconnect) as error:
                ws.receive_json()
            assert error.value.code == 1008
