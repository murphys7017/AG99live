from __future__ import annotations

from typing import Any

"""Live2D standard channel definitions and scan constants."""
STANDARD_CHANNEL_SPECS: tuple[dict[str, Any], ...] = (
    {
        "name": "head_yaw",
        "label": "Head Yaw",
        "exact_ids": ("ParamAngleX",),
        "tokens": ("anglex", "headx"),
    },
    {
        "name": "head_pitch",
        "label": "Head Pitch",
        "exact_ids": ("ParamAngleY",),
        "tokens": ("angley", "heady"),
    },
    {
        "name": "head_roll",
        "label": "Head Roll",
        "exact_ids": ("ParamAngleZ",),
        "tokens": ("anglez", "headz"),
    },
    {
        "name": "body_yaw",
        "label": "Body Yaw",
        "exact_ids": ("ParamBodyAngleX",),
        "tokens": ("bodyanglex", "bodyx"),
    },
    {
        "name": "body_roll",
        "label": "Body Roll",
        "exact_ids": ("ParamBodyAngleZ",),
        "tokens": ("bodyanglez", "bodyz"),
    },
    {
        "name": "body_pitch",
        "label": "Body Pitch",
        "exact_ids": ("BodyAngleY",),
        "tokens": ("bodyangley", "bodypitch", "bodyy"),
    },
    {
        "name": "gaze_x",
        "label": "Gaze X",
        "exact_ids": ("ParamEyeBallX",),
        "tokens": ("eyeballx", "eyex"),
    },
    {
        "name": "gaze_y",
        "label": "Gaze Y",
        "exact_ids": ("ParamEyeBallY",),
        "tokens": ("eyebally", "eyey"),
    },
    {
        "name": "eye_open_left",
        "label": "Eye Open Left",
        "exact_ids": ("ParamEyeLOpen",),
        "tokens": ("eyelopenl",),
    },
    {
        "name": "eye_open_right",
        "label": "Eye Open Right",
        "exact_ids": ("ParamEyeROpen",),
        "tokens": ("eyelopenr",),
    },
    {
        "name": "eye_smile_left",
        "label": "Eye Smile Left",
        "exact_ids": ("ParamEyeLSmile",),
        "tokens": ("eyesmilel",),
    },
    {
        "name": "eye_smile_right",
        "label": "Eye Smile Right",
        "exact_ids": ("ParamEyeRSmile",),
        "tokens": ("eyesmiler",),
    },
    {
        "name": "brow_bias",
        "label": "Brow Bias",
        "exact_ids": ("ParamBrowForm",),
        "tokens": ("browform", "brow"),
    },
    {
        "name": "brow_left_detail",
        "label": "Brow Left Detail",
        "exact_ids": ("ParamBrowLDown",),
        "tokens": ("browldown", "browleftdown"),
    },
    {
        "name": "brow_right_detail",
        "label": "Brow Right Detail",
        "exact_ids": ("ParamBrowRDown",),
        "tokens": ("browrdown", "browrightdown"),
    },
    {
        "name": "mouth_smile",
        "label": "Mouth Smile",
        "exact_ids": ("ParamMouthForm",),
        "tokens": ("mouthform", "mouthsmile"),
    },
    {
        "name": "mouth_open",
        "label": "Mouth Open",
        "exact_ids": ("ParamMouthOpenY", "ParamJawOpen"),
        "tokens": ("mouthopen", "jawopen"),
    },
    {
        "name": "mouth_x",
        "label": "Mouth X",
        "exact_ids": ("ParamMouthX",),
        "tokens": ("mouthx",),
    },
    {
        "name": "breath",
        "label": "Breath",
        "exact_ids": ("ParamBreath",),
        "tokens": ("breath",),
    },
)

BASE_EXPRESSION_NAMES = {
    "neutral",
    "happy",
    "angry",
    "surprised",
    "question",
    "confused",
    "embarrassed",
    "blush",
    "tired",
    "extremelytired",
    "messy",
    "murderous",
}

SPECIAL_EXPRESSION_KEYWORDS = {
    "controller",
    "tracking",
    "tablet",
    "pen",
    "outfit",
    "jaketoff",
    "mouseclick",
    "loading",
    "eyemask",
}

BASE_ACTION_LIBRARY_SCHEMA_VERSION = "base_action_library.v1"
PARAMETER_ACTION_LIBRARY_SCHEMA_VERSION = "parameter_action_library.v1"
ADAPTIVE_PARAMETER_PROFILE_SCHEMA_VERSION = "adaptive_parameter_profile.v1"
CALIBRATION_PROFILE_SCHEMA_VERSION = "direct_parameter_calibration.v1"
VOICE_FOLLOWING_PROFILE_SCHEMA_VERSION = "ag99.voice_following_profile.v1"
MODEL_SUMMARY_SCHEMA_VERSION = "live2d_model_summary.v1"
PARAMETER_ACTION_MAX_ATOMS_PER_PARAMETER = 24

VOICE_FOLLOWING_CHANNEL_SPECS: tuple[dict[str, Any], ...] = (
    {
        "name": "head_yaw",
        "layer": "head",
        "amplitude": 5.2,
        "weight": 1.0,
        "phase": 0.0,
        "frequency_hz": 1.35,
    },
    {
        "name": "head_pitch",
        "layer": "head",
        "amplitude": 1.2,
        "weight": 0.35,
        "phase": 0.35,
        "frequency_hz": 0.68,
    },
    {
        "name": "head_roll",
        "layer": "head",
        "amplitude": 4.8,
        "weight": 1.0,
        "phase": 0.7,
        "frequency_hz": 1.45,
    },
    {
        "name": "body_yaw",
        "layer": "body",
        "amplitude": 3.2,
        "weight": 0.7,
        "phase": 0.2,
        "frequency_hz": 1.15,
    },
    {
        "name": "body_pitch",
        "layer": "body",
        "amplitude": 0.8,
        "weight": 0.25,
        "phase": 0.55,
        "frequency_hz": 0.55,
    },
    {
        "name": "body_roll",
        "layer": "body",
        "amplitude": 3.0,
        "weight": 0.7,
        "phase": 0.85,
        "frequency_hz": 1.2,
    },
)

CORE_BASE_ACTION_CHANNEL_SPECS: tuple[dict[str, Any], ...] = (
    {
        "name": "head_yaw",
        "label": "Head Yaw",
        "family": "head_pose",
        "family_label": "Head Pose",
        "domain": "head",
        "max_atoms": 6,
    },
    {
        "name": "head_pitch",
        "label": "Head Pitch",
        "family": "head_pose",
        "family_label": "Head Pose",
        "domain": "head",
        "max_atoms": 6,
    },
    {
        "name": "head_roll",
        "label": "Head Roll",
        "family": "head_pose",
        "family_label": "Head Pose",
        "domain": "head",
        "max_atoms": 6,
    },
    {
        "name": "body_yaw",
        "label": "Body Yaw",
        "family": "body_pose",
        "family_label": "Body Pose",
        "domain": "body",
        "max_atoms": 5,
    },
    {
        "name": "body_roll",
        "label": "Body Roll",
        "family": "body_pose",
        "family_label": "Body Pose",
        "domain": "body",
        "max_atoms": 5,
    },
    {
        "name": "body_pitch",
        "label": "Body Pitch",
        "family": "body_pose",
        "family_label": "Body Pose",
        "domain": "body",
        "max_atoms": 5,
    },
    {
        "name": "gaze_x",
        "label": "Gaze X",
        "family": "gaze",
        "family_label": "Gaze",
        "domain": "gaze",
        "max_atoms": 5,
    },
    {
        "name": "gaze_y",
        "label": "Gaze Y",
        "family": "gaze",
        "family_label": "Gaze",
        "domain": "gaze",
        "max_atoms": 5,
    },
    {
        "name": "eye_open_left",
        "label": "Eye Open Left",
        "family": "eye",
        "family_label": "Eyes",
        "domain": "eye",
        "max_atoms": 4,
    },
    {
        "name": "eye_open_right",
        "label": "Eye Open Right",
        "family": "eye",
        "family_label": "Eyes",
        "domain": "eye",
        "max_atoms": 4,
    },
    {
        "name": "eye_smile_left",
        "label": "Eye Smile Left",
        "family": "eye",
        "family_label": "Eyes",
        "domain": "eye",
        "max_atoms": 4,
    },
    {
        "name": "eye_smile_right",
        "label": "Eye Smile Right",
        "family": "eye",
        "family_label": "Eyes",
        "domain": "eye",
        "max_atoms": 4,
    },
    {
        "name": "brow_bias",
        "label": "Brow Bias",
        "family": "brow",
        "family_label": "Brows",
        "domain": "brow",
        "max_atoms": 5,
    },
    {
        "name": "brow_left_detail",
        "label": "Brow Left Detail",
        "family": "brow",
        "family_label": "Brows",
        "domain": "brow",
        "max_atoms": 4,
    },
    {
        "name": "brow_right_detail",
        "label": "Brow Right Detail",
        "family": "brow",
        "family_label": "Brows",
        "domain": "brow",
        "max_atoms": 4,
    },
    {
        "name": "mouth_smile",
        "label": "Mouth Smile",
        "family": "mouth",
        "family_label": "Mouth",
        "domain": "mouth",
        "max_atoms": 5,
    },
    {
        "name": "mouth_open",
        "label": "Mouth Open",
        "family": "mouth",
        "family_label": "Mouth",
        "domain": "mouth",
        "max_atoms": 5,
    },
    {
        "name": "mouth_x",
        "label": "Mouth X",
        "family": "mouth",
        "family_label": "Mouth",
        "domain": "mouth",
        "max_atoms": 4,
    },
    {
        "name": "breath",
        "label": "Breath",
        "family": "breath",
        "family_label": "Breath",
        "domain": "breath",
        "max_atoms": 3,
    },
)


