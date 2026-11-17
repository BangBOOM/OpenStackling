import copy

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from support import Hold
from test_disconnect import FIXTURE, calibration_for
from test_server import envelope, hello

from stackling_policy.contract import PROTOCOL, digest
from stackling_policy.server import create_app


def configure(ws, profile):
    ws.send_json(
        envelope(
            "configure",
            2,
            profileHash=digest(profile),
            configuration=profile["config"],
            configurationHash=digest(profile["config"]),
            calibration=calibration_for(profile),
        )
    )
    return ws.receive_json()


def start(ws, actual, request, episode):
    ws.send_json(
        envelope(
            "episode_start", request, episode, actual=actual, configHash=digest(actual)
        )
    )
    return ws.receive_json()


def end(ws, request, episode):
    ws.send_json(
        envelope(
            "episode_end",
            request,
            episode,
            summary={
                "outcome": "completed",
                "reason": "test",
                "ticks": 0,
                "seconds": 0,
            },
        )
    )
    assert ws.receive_json()["type"] == "episode_ended"


class AppearanceProbe(Hold):
    def __init__(self):
        self.contexts = []

    def reset(self, context):
        assert set(context.config) == {"environment", "camera", "run"}
        assert set(context.config["run"]) == {"controlHz", "observationHz"}
        assert set(vars(context)) == {
            "episode_id",
            "seed",
            "config",
            "calibration",
            "task",
        }
        assert set(vars(context.task)) == {"prompt", "language", "control_seconds"}
        self.contexts.append(context)
        super().reset(context)


def test_same_connection_accepts_changed_appearance_and_checks_actual_hash():
    profile = copy.deepcopy(FIXTURE["profile"])
    original = copy.deepcopy(profile)
    policy = AppearanceProbe()
    with TestClient(create_app(profile, policy, "probe", "1")) as client:
        with client.websocket_connect("/policy", subprotocols=[PROTOCOL]) as ws:
            hello(ws)
            assert configure(ws, profile)["type"] == "configured"
            for i, theme in enumerate(["island", "studio", "laboratory"]):
                actual = copy.deepcopy(FIXTURE["actual"])
                actual["appearance"]["id"] = theme
                assert (
                    start(ws, actual, 3 + i * 2, f"ep-{i}")["type"] == "episode_ready"
                )
                end(ws, 4 + i * 2, f"ep-{i}")
            actual["appearance"]["id"] = "studio"
            ws.send_json(
                envelope(
                    "episode_start",
                    9,
                    "bad",
                    actual=actual,
                    configHash=digest(FIXTURE["actual"]),
                )
            )
            assert ws.receive_json()["code"] == "CONFIG_MISMATCH"
    assert len(policy.contexts) == 3
    assert profile == original


def test_changed_core_configuration_is_rejected():
    profile = copy.deepcopy(FIXTURE["profile"])
    config = copy.deepcopy(profile["config"])
    config["environment"]["friction"] += 0.1
    with TestClient(create_app(profile, Hold(), "hold", "1")) as client:
        with client.websocket_connect("/policy", subprotocols=[PROTOCOL]) as ws:
            hello(ws)
            ws.send_json(
                envelope(
                    "configure",
                    2,
                    profileHash=digest(profile),
                    configuration=config,
                    configurationHash=digest(config),
                    calibration=calibration_for(profile),
                )
            )
            assert ws.receive_json()["code"] == "CONFIG_MISMATCH"


@pytest.mark.parametrize("offered", [[], ["unrelated.protocol"]])
def test_connection_requires_policy_subprotocol(offered):
    with TestClient(create_app(FIXTURE["profile"], Hold(), "hold", "1")) as client:
        with client.websocket_connect("/policy", subprotocols=offered) as ws:
            with pytest.raises(WebSocketDisconnect) as error:
                ws.receive_json()
            assert error.value.code == 1002
            assert error.value.reason == f"Only {PROTOCOL} is supported"


def test_dynamic_episodes_receive_only_current_prompt_and_time_limits():
    profile = copy.deepcopy(FIXTURE["profile"])
    profile["trainingTasks"] = []
    original = copy.deepcopy(profile)
    first = copy.deepcopy(FIXTURE["actual"])
    second = copy.deepcopy(first)
    case = second["taskCase"]
    case["scene"]["objects"].append(copy.deepcopy(case["scene"]["objects"][0]))
    case["scene"]["objects"][-1]["id"] = "extra"
    case["scene"]["objects"][-1]["shape"] = {"kind": "sphere", "radius": 0.04}
    case["task"] = {"kind": "max-height", "language": "zh", "stableSeconds": 3}
    case["maxSeconds"] = 240
    case["prompt"] = {
        "templateId": "max-height",
        "templateVersion": 1,
        "language": "zh",
        "text": "在时限内堆得尽可能高。",
    }
    second["appearance"]["id"] = "studio"
    second["cameraSeed"] = 2026
    policy = AppearanceProbe()
    with TestClient(create_app(profile, policy, "prompt", "1")) as client:
        with client.websocket_connect("/policy", subprotocols=[PROTOCOL]) as ws:
            hello(ws)
            assert configure(ws, profile)["type"] == "configured"
            for index, actual in enumerate([first, second]):
                assert (
                    start(ws, actual, 3 + index * 2, f"e{index}")["type"]
                    == "episode_ready"
                )
                end(ws, 4 + index * 2, f"e{index}")
    assert profile == original
    assert len(policy.contexts) == 2
    assert policy.contexts[0].config == policy.contexts[1].config
    assert policy.contexts[1].task.prompt == case["prompt"]["text"]
    assert policy.contexts[1].task.language == "zh"
    assert policy.contexts[1].task.control_seconds == 240
    assert policy.contexts[0].task.prompt != policy.contexts[1].task.prompt


def test_historical_training_prompt_is_provenance_only():
    profile = copy.deepcopy(FIXTURE["profile"])
    profile["trainingTasks"][0]["prompt"]["text"] = "Historical training wording."
    profile["trainingTasks"][0]["prompt"]["templateVersion"] = 7
    policy = AppearanceProbe()
    with TestClient(create_app(profile, policy, "probe", "1")) as client:
        with client.websocket_connect("/policy", subprotocols=[PROTOCOL]) as ws:
            hello(ws)
            assert configure(ws, profile)["type"] == "configured"
            assert start(ws, FIXTURE["actual"], 3, "current")["type"] == "episode_ready"
            end(ws, 4, "current")
    assert (
        policy.contexts[0].task.prompt
        == FIXTURE["actual"]["taskCase"]["prompt"]["text"]
    )


@pytest.mark.parametrize("mismatch", ["runtime", "prompt", "scene"])
def test_invalid_episode_is_rejected(mismatch):
    profile = copy.deepcopy(FIXTURE["profile"])
    actual = copy.deepcopy(FIXTURE["actual"])
    if mismatch == "runtime":
        actual["configuration"]["run"]["controlHz"] = 10
    elif mismatch == "prompt":
        actual["taskCase"]["prompt"]["language"] = "zh"
    else:
        actual["taskCase"]["scene"]["objects"][1]["id"] = actual["taskCase"]["scene"][
            "objects"
        ][0]["id"]
    with TestClient(create_app(profile, Hold(), "probe", "1")) as client:
        with client.websocket_connect("/policy", subprotocols=[PROTOCOL]) as ws:
            hello(ws)
            assert configure(ws, profile)["type"] == "configured"
            assert start(ws, actual, 3, "invalid")["code"] == "CONFIG_MISMATCH"
