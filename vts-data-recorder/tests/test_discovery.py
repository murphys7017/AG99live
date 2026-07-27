import pytest

from ag99_vts_recorder.discovery import live2d_values
from ag99_vts_recorder.protocol import VTSProtocolError


def test_live2d_values_reads_the_official_parameters_field() -> None:
    values = live2d_values(
        {
            "modelLoaded": True,
            "parameters": [
                {
                    "name": "ParamAngleX",
                    "value": 12.4,
                    "min": -30,
                    "max": 30,
                    "defaultValue": 0,
                }
            ],
        }
    )

    assert values == {"ParamAngleX": 12.4}


def test_live2d_values_rejects_a_missing_parameters_array() -> None:
    with pytest.raises(VTSProtocolError, match="parameters"):
        live2d_values({"modelLoaded": True})
