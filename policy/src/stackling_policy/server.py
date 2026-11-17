import asyncio
import copy
import json
import logging
import math
import secrets
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .contract import (
    PROTOCOL,
    PolicyError,
    decode_observation,
    decode_packet,
    digest,
    validate,
    validate_action,
    validate_actual,
    validate_profile,
)
from .interfaces import (
    ActionTarget,
    ControlContext,
    EpisodeContext,
    EpisodeSummary,
    TaskContext,
)


def check_calibration(cal, config):
    cam = config["camera"]
    if cam["mount"] == "head":
        mount = config["environment"]["robot"]["mount"]
        head = cam["head"]
        pitch = math.radians(head["pitch"])
        tilt = math.pi / 12
        origin = np.array(
            [
                mount["column"]["x"],
                mount["neck"]["top"] + 0.09,
                mount["column"]["z"] + 0.045,
            ]
        )
        window = origin + np.array(
            [
                0,
                0.028 * math.cos(tilt) - 0.082 * math.sin(tilt),
                0.028 * math.sin(tilt) + 0.082 * math.cos(tilt),
            ]
        )
        forward = np.array([0, -math.sin(pitch), math.cos(pitch)])
        p = window + 0.006 * forward
        matrix = np.eye(4)
        matrix[:3, :3] = np.array(
            [
                [-1, 0, 0],
                [0, math.cos(pitch), math.sin(pitch)],
                [0, math.sin(pitch), -math.cos(pitch)],
            ]
        )
        matrix[:3, 3] = p
        target = (p + forward).tolist()
        fov, near = head["fov"], head["near"]
    else:
        angle = (
            ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].index(cam["position"])
            * math.pi
            / 4
        )
        p = np.array(
            [
                math.sin(angle) * cam["distance"],
                config["environment"]["tableTop"] + cam["height"],
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
        target = cam["target"]
        fov, near = cam["fov"], cam["near"]
    fy = cam["heightPixels"] / (2 * math.tan(math.radians(fov) / 2))
    expected = {
        "width": cam["width"],
        "height": cam["heightPixels"],
        "intrinsics": [
            [fy, 0, cam["width"] / 2],
            [0, fy, cam["heightPixels"] / 2],
            [0, 0, 1],
        ],
        "cameraToWorld": matrix.flatten(order="F").tolist(),
        "position": p.tolist(),
        "target": target,
        "near": near,
        "far": cam["far"],
    }
    if any(not np.allclose(cal[k], v, rtol=0, atol=1e-9) for k, v in expected.items()):
        raise PolicyError("CONFIG_MISMATCH", "Camera calibration")


def create_app(
    profile,
    policy,
    policy_id,
    model_revision,
    token="",
    origins=(),
    handshake_timeout=30,
):
    validate_profile(profile)
    profile = copy.deepcopy(profile)
    manifest = {
        "protocol": PROTOCOL,
        "policyId": policy_id,
        "modelRevision": model_revision,
        "profile": profile,
        "profileHash": digest(profile),
    }
    validate(
        "message",
        {
            "type": "manifest",
            "sessionId": "startup",
            "episodeId": None,
            "requestId": 1,
            "manifest": manifest,
        },
    )
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="policy")
    lease = None

    @asynccontextmanager
    async def lifespan(app):
        yield
        executor.shutdown(wait=True)

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {
            "protocol": PROTOCOL,
            "busy": lease is not None,
            "policyId": policy_id,
            "modelRevision": model_revision,
        }

    @app.websocket("/policy")
    async def websocket(ws: WebSocket):
        nonlocal lease
        await ws.accept(
            subprotocol=PROTOCOL
            if PROTOCOL in ws.scope.get("subprotocols", [])
            else None
        )
        if PROTOCOL not in ws.scope.get("subprotocols", []):
            await ws.close(code=1002, reason=f"Only {PROTOCOL} is supported")
            return
        session = None
        last_request = 0
        configured = False
        episode_id = None
        calibration = None
        latest_observation = None
        observation_tick = 0
        control_tick = 0
        terminated = False
        tasks = set()
        serial = asyncio.Lock()
        owner = object()
        active_callback = None

        async def reply(request, kind, **fields):
            message = {k: request[k] for k in ("sessionId", "episodeId", "requestId")}
            message.update(type=kind, **fields)
            validate("message", message)
            try:
                await ws.send_json(message)
            except WebSocketDisconnect:
                pass  # The peer is gone; the receive loop observes it and cleans up.

        async def close(code=1000):
            try:
                await ws.close(code)
            except (RuntimeError, WebSocketDisconnect):
                pass  # Already closing or already gone; nothing to deliver.

        async def callback(method, value):
            nonlocal active_callback
            active_callback = asyncio.get_running_loop().run_in_executor(
                executor, getattr(policy, method), value
            )
            # Never cancel the executing model thread or release its lease early.
            return await asyncio.shield(active_callback)

        async def dispatch(m, payload):
            nonlocal \
                configured, \
                episode_id, \
                calibration, \
                latest_observation, \
                observation_tick, \
                control_tick, \
                terminated
            async with serial:
                if terminated:
                    return
                try:
                    kind = m["type"]
                    c = profile["config"]
                    if kind == "configure":
                        if configured or m["episodeId"] is not None:
                            raise PolicyError("INVALID_STATE")
                        if (
                            m["profileHash"] != manifest["profileHash"]
                            or m["configuration"] != c
                            or digest(m["configuration"]) != m["configurationHash"]
                        ):
                            raise PolicyError("CONFIG_MISMATCH")
                        check_calibration(m["calibration"], c)
                        calibration = copy.deepcopy(m["calibration"])
                        configured = True
                        await reply(
                            m, "configured", configurationHash=m["configurationHash"]
                        )
                    elif kind == "episode_start":
                        if (
                            not configured
                            or episode_id is not None
                            or not m["episodeId"]
                        ):
                            raise PolicyError("INVALID_STATE")
                        actual = m["actual"]
                        validate_actual(actual, c)
                        if digest(actual) != m["configHash"]:
                            raise PolicyError(
                                "CONFIG_MISMATCH", "Episode configuration hash"
                            )
                        selected = actual["taskCase"]
                        episode_id = m["episodeId"]
                        latest_observation, observation_tick, control_tick = None, 0, 0
                        await callback(
                            "reset",
                            EpisodeContext(
                                episode_id,
                                actual["seed"],
                                copy.deepcopy(c),
                                copy.deepcopy(calibration),
                                TaskContext(
                                    selected["prompt"]["text"],
                                    selected["prompt"]["language"],
                                    selected["maxSeconds"],
                                ),
                            ),
                        )
                        await reply(m, "episode_ready")
                    elif not episode_id or m["episodeId"] != episode_id:
                        raise PolicyError("INVALID_STATE", "Episode ID")
                    elif kind == "observation":
                        if (
                            m["tick"] != observation_tick
                            or abs(
                                m["time"] - m["tick"] / c["environment"]["physicsHz"]
                            )
                            > 1e-9
                        ):
                            raise PolicyError("INVALID_MESSAGE", "Observation clock")
                        try:
                            observation = decode_observation(m, payload, c["camera"])
                        except (OSError, ValueError) as error:
                            raise PolicyError(
                                "INVALID_MESSAGE", "Image encoding"
                            ) from error
                        await callback("observe", observation)
                        latest_observation = m["requestId"]
                        observation_tick += (
                            c["environment"]["physicsHz"] // c["run"]["observationHz"]
                        )
                        await reply(m, "observed", tick=m["tick"])
                    elif kind == "act":
                        if (
                            m["tick"] != control_tick
                            or m["observationId"] != latest_observation
                            or latest_observation is None
                            or abs(m["dt"] - 1 / c["run"]["controlHz"]) > 1e-12
                        ):
                            raise PolicyError("INVALID_MESSAGE", "Control clock")
                        # Observations due at this control tick must already exist.
                        expected = (
                            m["tick"]
                            // (
                                c["environment"]["physicsHz"]
                                // c["run"]["observationHz"]
                            )
                            + 1
                        ) * (c["environment"]["physicsHz"] // c["run"]["observationHz"])
                        if observation_tick != expected:
                            raise PolicyError("INVALID_STATE", "Observation missing")
                        action = await callback(
                            "act",
                            ControlContext(m["tick"], m["dt"], latest_observation),
                        )
                        if not isinstance(action, ActionTarget) or not isinstance(
                            action.continuous, bool
                        ):
                            raise PolicyError(
                                "INVALID_ACTION",
                                "Expected an ActionTarget with a boolean continuous flag",
                            )
                        validate_action(action.action, c)
                        control_tick += (
                            c["environment"]["physicsHz"] // c["run"]["controlHz"]
                        )
                        await reply(
                            m,
                            "action",
                            tick=m["tick"],
                            action=action.action,
                            continuous=action.continuous,
                        )
                    elif kind == "episode_end":
                        episode_id = None
                        await callback("end", EpisodeSummary(**m["summary"]))
                        await reply(m, "episode_ended")
                    else:
                        raise PolicyError("INVALID_STATE")
                except Exception as e:
                    if not isinstance(e, PolicyError):
                        logging.exception("Policy callback failed")
                    error = (
                        e
                        if isinstance(e, PolicyError)
                        else PolicyError("MODEL_ERROR", type(e).__name__)
                    )
                    terminated = True
                    try:
                        await reply(
                            m, "error", code=error.code, params={"detail": error.detail}
                        )
                    finally:
                        await close(1011)

        try:
            raw = await asyncio.wait_for(ws.receive_text(), handshake_timeout)
            if len(raw.encode()) > 65536:
                raise PolicyError("INVALID_MESSAGE")
            hello = json.loads(raw)
            # Only a validated request can receive an error envelope.
            validate("message", hello)
            if hello["type"] != "hello" or hello["episodeId"] is not None:
                raise PolicyError("INVALID_MESSAGE")
            error = None
            if (token and not secrets.compare_digest(hello["token"], token)) or (
                ws.headers.get("origin")
                and origins
                and ws.headers["origin"] not in origins
            ):
                error = PolicyError("AUTH_FAILED")
            elif lease is not None:
                error = PolicyError("SERVER_BUSY")
            if error:
                await reply(
                    hello, "error", code=error.code, params={"detail": error.detail}
                )
                return
            lease = owner
            session = hello["sessionId"]
            last_request = hello["requestId"]
            await reply(hello, "manifest", manifest=manifest)
            while True:
                event = await ws.receive()
                if event["type"] == "websocket.disconnect":
                    break
                if event.get("bytes") is not None:
                    m, payload = decode_packet(event["bytes"])
                else:
                    raw = event["text"]
                    if len(raw.encode()) > 65536:
                        raise PolicyError("INVALID_MESSAGE")
                    m, payload = json.loads(raw), None
                    validate("message", m)
                    if m["type"] == "observation":
                        raise PolicyError(
                            "INVALID_MESSAGE", "Binary observation required"
                        )
                if m["sessionId"] != session or m["requestId"] <= last_request:
                    raise PolicyError("INVALID_MESSAGE", "Request ID")
                last_request = m["requestId"]
                # Allow one request plus its queued end, not an unbounded queue.
                if tasks and (m["type"] != "episode_end" or len(tasks) >= 2):
                    raise PolicyError("INVALID_STATE", "Request in flight")
                task = asyncio.create_task(dispatch(m, payload))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception:
            await close(1008)
        finally:
            terminated = True
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            if active_callback is not None:
                await asyncio.gather(active_callback, return_exceptions=True)
            if episode_id is not None:
                try:
                    await callback(
                        "end",
                        EpisodeSummary(
                            "error",
                            "Connection closed",
                            control_tick,
                            control_tick
                            / profile["config"]["environment"]["physicsHz"],
                        ),
                    )
                except Exception:
                    logging.exception("Policy cleanup failed")
            if lease is owner:
                lease = None
            await close()

    return app
