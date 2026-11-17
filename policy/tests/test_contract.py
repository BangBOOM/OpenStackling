import copy
import json
from pathlib import Path

import pytest

from stackling_policy.contract import PolicyError, digest, validate_profile

FIXTURES = json.loads(
    (Path(__file__).resolve().parents[2] / "protocol/fixtures.json").read_text()
)


def test_shared_valid_profile_and_jcs():
    validate_profile(FIXTURES["profile"])
    assert digest(FIXTURES["canonical"]) == FIXTURES["canonicalHash"]
    assert digest(FIXTURES["actual"]) == FIXTURES["actualHash"]


@pytest.mark.parametrize("sample", FIXTURES["cases"], ids=lambda s: s["path"])
def test_shared_invalid_profiles(sample):
    p = copy.deepcopy(FIXTURES["profile"])
    keys = sample["path"].split(".")
    node = p
    for key in keys[:-1]:
        node = node[int(key)] if isinstance(node, list) else node[key]
    node[int(keys[-1]) if isinstance(node, list) else keys[-1]] = sample["value"]
    with pytest.raises(PolicyError):
        validate_profile(p)


def test_nonfinite():
    p = copy.deepcopy(FIXTURES["profile"])
    p["config"]["camera"]["fov"] = float("inf")
    with pytest.raises(PolicyError):
        validate_profile(p)


def test_rectangular_table_depth_is_required_and_validated():
    p = copy.deepcopy(FIXTURES["profile"])
    validate_profile(p)
    p["config"]["environment"]["tableDepth"] = 0.1
    with pytest.raises(PolicyError):
        validate_profile(p)
    for case in p["trainingTasks"]:
        case["scene"]["region"] = [-0.4, 0.4, -0.04, 0.04]
    validate_profile(p)
    p["config"]["environment"]["tableDepth"] = 0
    with pytest.raises(PolicyError):
        validate_profile(p)


def test_table_support_is_required_and_validated():
    p = copy.deepcopy(FIXTURES["profile"])
    validate_profile(p)
    for support in ["legs", "sled"]:
        p["config"]["environment"]["tableSupport"] = support
        validate_profile(p)
    p["config"]["environment"]["tableSupport"] = "unknown"
    with pytest.raises(PolicyError):
        validate_profile(p)


def test_head_camera_profile_and_mount_validation():
    p = copy.deepcopy(FIXTURES["profile"])
    p["config"]["environment"]["robot"]["mount"]["type"] = "human-scale-upper-body-v1"
    p["config"]["camera"].update(
        mount="head", head={"pitch": 55, "fov": 70, "near": 0.02}
    )
    validate_profile(p)
    p["config"]["camera"]["head"]["pitch"] = 75
    with pytest.raises(PolicyError):
        validate_profile(p)
    p["config"]["camera"]["head"]["pitch"] = 55
    p["config"]["environment"]["robot"]["mount"]["type"] = "table-edge-bracket"
    with pytest.raises(PolicyError):
        validate_profile(p)


@pytest.mark.parametrize("field", ["tableDepth", "tableSupport"])
def test_profile_requires_complete_environment(field):
    p = copy.deepcopy(FIXTURES["profile"])
    del p["config"]["environment"][field]
    with pytest.raises(PolicyError):
        validate_profile(p)


def test_profile_requires_articulated_body():
    p = copy.deepcopy(FIXTURES["profile"])
    del p["config"]["environment"]["robot"]["body"]
    with pytest.raises(PolicyError):
        validate_profile(p)


def test_profile_validates_waist_both_arms_and_both_gaps():
    from stackling_policy.contract import validate_action

    c = FIXTURES["profile"]["config"]
    r = c["environment"]["robot"]
    action = [
        0,
        0,
        *r["homeJoints"],
        r["home"]["gap"],
        *r["homeJoints"],
        r["home"]["gap"],
    ]
    validate_action(action, c)
    limits = [
        [-r["body"]["yawLimit"], r["body"]["yawLimit"]],
        [0, r["body"]["pitchLimit"]],
        *r["limits"],
        r["gap"],
        *r["limits"],
        r["gap"],
    ]
    for index, (low, high) in enumerate(limits):
        for value in [low - 0.001, high + 0.001, float("nan"), True]:
            invalid = list(action)
            invalid[index] = value
            with pytest.raises(PolicyError):
                validate_action(invalid, c)
    with pytest.raises(PolicyError):
        validate_action(action[2:9], c)


@pytest.mark.parametrize(
    "sample", FIXTURES["calibrations"], ids=lambda sample: sample["mount"]
)
def test_camera_calibration_matches_typescript(sample):
    from stackling_policy.server import check_calibration

    check_calibration(sample["calibration"], sample["config"])
    invalid = copy.deepcopy(sample["calibration"])
    invalid["cameraToWorld"][12] += 0.01
    with pytest.raises(PolicyError):
        check_calibration(invalid, sample["config"])
