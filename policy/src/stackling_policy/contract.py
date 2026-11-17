import gzip
import hashlib
import io
import json
import math
import struct
from importlib.resources import files

import numpy as np
import rfc8785
from jsonschema import Draft202012Validator
from PIL import Image

from .interfaces import Observation

MAX_BYTES = 128 * 1024 * 1024
SCHEMA = json.loads(files("stackling_policy").joinpath("schema.json").read_text())
PROTOCOL = SCHEMA["$defs"]["protocol"]["const"]
VALIDATORS = {
    k: Draft202012Validator({**SCHEMA, "$ref": f"#/$defs/{k}"})
    for k in ("message", "profile", "actual")
}


class PolicyError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail)
        self.code, self.detail = code, detail


def finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise PolicyError("INVALID_MESSAGE", "Non-finite number")
    if isinstance(value, dict):
        for v in value.values():
            finite(v)
    elif isinstance(value, list):
        for v in value:
            finite(v)


def validate(kind, value):
    finite(value)
    error = next(VALIDATORS[kind].iter_errors(value), None)
    if error:
        raise PolicyError("INVALID_MESSAGE", error.message)


def digest(value):
    return hashlib.sha256(rfc8785.dumps(value)).hexdigest()


def validate_profile(profile):
    validate("profile", profile)
    c = profile["config"]
    e, cam, run = (c[k] for k in ("environment", "camera", "run"))
    r = e["robot"]
    head = cam["head"]
    valid = (
        (cam["mount"] != "head" or r["mount"]["type"] == "human-scale-upper-body-v1")
        and head["near"] < cam["far"]
        and all(e["physicsHz"] % run[k] == 0 for k in ("controlHz", "observationHz"))
        and cam["far"] > (head["near"] if cam["mount"] == "head" else cam["near"])
        and r["gap"][0] >= 0
        and r["gap"][1] > r["gap"][0]
        and r["gap"][0] <= r["home"]["gap"] <= r["gap"][1]
        and all(abs(math.hypot(*a) - 1) <= 1e-6 for a in r["axes"])
        and all(
            b[0] < b[1] and b[0] <= q <= b[1]
            for b, q in zip(r["limits"], r["homeJoints"])
        )
        and r["links"][0] == 0
        and min(r["links"][1:3]) > 0.08
        and min(r["links"][3:]) > 0
    )
    positives = [
        r[k]
        for k in (
            "toolLength",
            "fingerLength",
            "fingerWidth",
            "fingerDepth",
            "jointSpeed",
            "jointAcceleration",
            "jointJerk",
            "keyboardSpeed",
        )
    ]
    positives += list(r["speed"].values()) + [
        r["armMotor"][k] for k in ("stiffness", "damping")
    ]
    positives += r["armMotor"]["maxTorque"] + [
        r["fingerMotor"][k] for k in ("stiffness", "damping", "maxForce")
    ]
    positives += [r["body"]["jerk"]]
    positives += [r["body"]["motor"][k] for k in ("stiffness", "damping")]
    positives += r["body"]["motor"]["maxTorque"]
    valid = (
        valid
        and r["inertials"]["source"].strip()
        and min(r["fingerMotor"][k] for k in ("couplingStiffness", "couplingDamping"))
        >= 0
    )
    for inertial in [
        *r["inertials"]["arms"],
        *(r["inertials"][k] for k in ("finger", "yaw", "torso")),
    ]:
        moments = inertial["principalInertia"]
        valid = (
            valid
            and max(moments) * 2 <= sum(moments) + 1e-9
            and abs(math.hypot(*inertial["inertiaFrame"]) - 1) <= 1e-6
        )
    if not valid or min(positives) <= 0:
        raise PolicyError(
            "CONFIG_MISMATCH", "Configuration semantic constraints failed"
        )

    for case in profile["trainingTasks"]:
        validate_task_case(case, e)


def validate_actual(actual, config):
    validate("actual", actual)
    if actual["configuration"] != config:
        raise PolicyError("CONFIG_MISMATCH", "Runtime configuration")
    validate_task_case(actual["taskCase"], config["environment"])


def validate_task_case(case, e):
    scene, task = case["scene"], case["task"]
    objects = scene["objects"]
    ids = [o["id"] for o in objects]
    if len(set(ids)) != len(ids):
        raise PolicyError("CONFIG_MISMATCH", "Duplicate object IDs")
    region = scene["region"]
    if not (
        region[0] < region[1]
        and region[2] < region[3]
        and max(map(abs, region[:2])) <= e["tableSize"] / 2
        and max(map(abs, region[2:])) <= e["tableDepth"] / 2
    ):
        raise PolicyError("CONFIG_MISMATCH", "Sampling region")
    for o in objects:
        if abs(math.hypot(*o["rotation"].values()) - 1) > 1e-6:
            raise PolicyError("CONFIG_MISMATCH", "Object rotation")
    if task["kind"] != "max-height":
        if any(
            o["shape"]["kind"] != "cuboid"
            or any(abs(v - o["shape"]["size"][0]) >= 1e-8 for v in o["shape"]["size"])
            for o in objects
        ):
            raise PolicyError("CONFIG_MISMATCH", "Completion tasks require cubes")
        sizes = [o["shape"]["size"][0] for o in objects]
        if task["kind"] == "tower":
            height = sum(sizes)
        else:
            if any(size != sizes[0] for size in sizes):
                raise PolicyError(
                    "CONFIG_MISMATCH", "Partition tasks require equal cubes"
                )
            if task["kind"] == "partition-count":
                counts = task["counts"]
                if sum(counts) != len(objects):
                    raise PolicyError("CONFIG_MISMATCH", "Tower counts")
            else:
                counts = [
                    sum(o["color"] == color for o in objects)
                    for color in set(o["color"] for o in objects)
                ]
            height = max(counts) * sizes[0]
        if height > scene["maxStackHeight"] + 1e-8:
            raise PolicyError("CONFIG_MISMATCH", "Tower height")
    if (
        case["prompt"]["language"] != task["language"]
        or case["prompt"]["templateId"] != task["kind"]
    ):
        raise PolicyError("CONFIG_MISMATCH", "Prompt contract")


def validate_action(action, config):
    r = config["environment"]["robot"]
    body = r["body"]
    limits = [
        [-body["yawLimit"], body["yawLimit"]],
        [0, body["pitchLimit"]],
        *r["limits"],
        r["gap"],
        *r["limits"],
        r["gap"],
    ]
    if (
        not isinstance(action, list)
        or len(action) != 16
        or any(
            isinstance(v, bool)
            or not isinstance(v, (int, float))
            or not math.isfinite(v)
            or not lo <= v <= hi
            for v, (lo, hi) in zip(action, limits)
        )
    ):
        raise PolicyError("INVALID_ACTION")


def decode_packet(data):
    if len(data) < 4 or len(data) > MAX_BYTES:
        raise PolicyError("INVALID_MESSAGE", "Message length")
    size = struct.unpack_from("<I", data)[0]
    if size > 65536 or size + 4 > len(data):
        raise PolicyError("INVALID_MESSAGE", "Header length")
    header = json.loads(data[4 : 4 + size])
    validate("message", header)
    if header["type"] != "observation" or 4 + size + header["rgbBytes"] + header[
        "depthBytes"
    ] != len(data):
        raise PolicyError("INVALID_MESSAGE", "Payload length")
    return header, data[4 + size :]


def decode_observation(header, payload, camera):
    if bool(header["depthBytes"]) != camera["depth"]:
        raise PolicyError("INVALID_MESSAGE", "Depth presence")
    image = Image.open(io.BytesIO(payload[: header["rgbBytes"]]))
    expected = (camera["width"], camera["heightPixels"])
    if image.format != "PNG" or image.size != expected:
        raise PolicyError("INVALID_MESSAGE", "PNG dimensions")
    rgb = np.array(image.convert("RGB"), dtype=np.uint8)
    depth = None
    if camera["depth"]:
        count = expected[0] * expected[1] * 2
        with gzip.GzipFile(fileobj=io.BytesIO(payload[header["rgbBytes"] :])) as stream:
            raw = stream.read(count + 1)
        if len(raw) != count:
            raise PolicyError("INVALID_MESSAGE", "Depth dimensions")
        depth = np.frombuffer(raw, dtype="<u2").reshape(expected[1], expected[0]).copy()
    return Observation(
        header["requestId"],
        header["tick"],
        header["time"],
        tuple(header["state"]),
        rgb,
        depth,
        np.array(header["cameraToWorld"], dtype=np.float64).reshape(4, 4, order="F"),
    )
