from ag99_vts_recorder.protocol import (
    API_NAME,
    API_VERSION,
    VTSAPIError,
    build_request,
    parse_inbound_message,
    raise_for_api_error,
)


def test_build_request_uses_vts_envelope() -> None:
    request = build_request(
        "APIStateRequest",
        {"example": True},
        request_id="probe-request",
    )

    assert request == {
        "apiName": API_NAME,
        "apiVersion": API_VERSION,
        "requestID": "probe-request",
        "messageType": "APIStateRequest",
        "data": {"example": True},
    }


def test_api_error_response_is_reported() -> None:
    message = parse_inbound_message(
        {
            "requestID": "probe-request",
            "messageType": "APIError",
            "timestamp": 12.5,
            "data": {"errorID": 401, "message": "Not authenticated"},
        }
    )

    assert message.timestamp_ms == 12
    try:
        raise_for_api_error(message)
    except VTSAPIError as exc:
        assert exc.error_id == 401
        assert "Not authenticated" in str(exc)
    else:
        raise AssertionError("APIError responses must raise VTSAPIError")
