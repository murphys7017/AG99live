import pytest


def test_expression_record_preserves_timing_and_sparse_axes(install_fake_astrbot):
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.provider_contract import expression_record

    points = [{"ms": 140, "gaze_x": 68}, {"ms": 300}, {"ms": 260, "head_yaw": 62}]
    result = expression_record(points)
    assert [{"ms": step["ms"], **step["axis_values"]} for step in result["motion_steps"]] == points
    with pytest.raises(ValueError):
        expression_record([{"ms": -20, "gaze_x": 68}])
