from ag99_vts_recorder.discovery import live2d_values


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
