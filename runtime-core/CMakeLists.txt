cmake_minimum_required(VERSION 3.25)

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../VERSION" AG99_PRODUCT_VERSION)
string(STRIP "${AG99_PRODUCT_VERSION}" AG99_PRODUCT_VERSION)
if(NOT AG99_PRODUCT_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+$")
  message(FATAL_ERROR
    "Root VERSION must contain a semantic product version (x.y.z), got: ${AG99_PRODUCT_VERSION}")
endif()
project(ag99_runtime_core VERSION ${AG99_PRODUCT_VERSION} LANGUAGES CXX)

include(FetchContent)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(AG99_RUNTIME_BUILD_REPLAY "Build the protocol replay executable" ON)
option(AG99_RUNTIME_BUILD_TESTS "Build protocol smoke tests" ON)

set(AG99_PROTOCOL_MANIFEST
  "${CMAKE_CURRENT_SOURCE_DIR}/../astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json")
if(NOT EXISTS "${AG99_PROTOCOL_MANIFEST}")
  message(FATAL_ERROR
    "AG99 protocol manifest was not found at ${AG99_PROTOCOL_MANIFEST}")
endif()

file(READ "${AG99_PROTOCOL_MANIFEST}" AG99_PROTOCOL_MANIFEST_JSON)
string(JSON AG99_PROTOCOL_VERSION
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" protocol_version)
string(JSON AG99_SCHEMA_PRE_ACTION
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas pre_action)
string(JSON AG99_SCHEMA_AUDIO_INPUT
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas audio_input)
string(JSON AG99_SCHEMA_AUDIO_CREDIT
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas audio_credit)
string(JSON AG99_SCHEMA_MODEL_INFO
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas model_info)
string(JSON AG99_SCHEMA_MOTION_INTENT
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas motion_intent)
string(JSON AG99_SCHEMA_MOTION_TUNING_SAMPLE
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas motion_tuning_sample)
string(JSON AG99_SCHEMA_OUTPUT_SEGMENT
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas output_segment)
string(JSON AG99_SCHEMA_PARAMETER_ACTION_LIBRARY
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas parameter_action_library)
string(JSON AG99_SCHEMA_PARAMETER_PLAN
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas parameter_plan)
string(JSON AG99_SCHEMA_PERFORMANCE_CURVE_HINT
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas performance_curve_hint)
string(JSON AG99_SCHEMA_SEMANTIC_AXIS_PROFILE
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas semantic_axis_profile)
string(JSON AG99_SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas semantic_axis_relation_graph)
string(JSON AG99_SCHEMA_VOICE_FOLLOWING_PROFILE
  GET "${AG99_PROTOCOL_MANIFEST_JSON}" schemas voice_following_profile)

set(AG99_RUNTIME_GENERATED_INCLUDE_DIR
  "${CMAKE_CURRENT_BINARY_DIR}/generated/include")
file(MAKE_DIRECTORY
  "${AG99_RUNTIME_GENERATED_INCLUDE_DIR}/ag99/runtime")
configure_file(
  "${CMAKE_CURRENT_SOURCE_DIR}/include/ag99/runtime/protocol_manifest.hpp.in"
  "${AG99_RUNTIME_GENERATED_INCLUDE_DIR}/ag99/runtime/protocol_manifest.hpp"
  @ONLY)

FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
)
FetchContent_MakeAvailable(nlohmann_json)

add_library(ag99_runtime_core
  src/incremental_output_assembler.cpp
  src/protocol.cpp
  src/runtime_session.cpp
  src/segment_assembler.cpp
)

target_include_directories(ag99_runtime_core
  PUBLIC
    ${AG99_RUNTIME_GENERATED_INCLUDE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(ag99_runtime_core
  PUBLIC
    nlohmann_json::nlohmann_json
)

if(WIN32)
  target_sources(ag99_runtime_core PRIVATE src/winhttp_websocket.cpp)
  target_link_libraries(ag99_runtime_core PRIVATE winhttp)
else()
  target_sources(ag99_runtime_core PRIVATE src/winhttp_websocket_stub.cpp)
endif()

target_compile_definitions(ag99_runtime_core
  PUBLIC
    AG99_RUNTIME_PROTOCOL_VERSION="v2"
)

if(MSVC)
  target_compile_options(ag99_runtime_core PRIVATE /W4 /permissive-)
else()
  target_compile_options(ag99_runtime_core PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(AG99_RUNTIME_BUILD_REPLAY)
  add_executable(ag99-runtime-replay src/replay_main.cpp)
  target_link_libraries(ag99-runtime-replay PRIVATE ag99_runtime_core)
endif()

if(AG99_RUNTIME_BUILD_TESTS)
  enable_testing()
  add_executable(ag99-runtime-protocol-smoke tests/protocol_smoke.cpp)
  target_link_libraries(ag99-runtime-protocol-smoke PRIVATE ag99_runtime_core)
  add_test(NAME ag99-runtime-protocol-smoke COMMAND ag99-runtime-protocol-smoke)
endif()
