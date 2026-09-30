cmake_minimum_required(VERSION 3.25)

project(ag99_runtime_core VERSION 0.1.0 LANGUAGES CXX)

include(FetchContent)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(AG99_RUNTIME_BUILD_REPLAY "Build the protocol replay executable" ON)
option(AG99_RUNTIME_BUILD_TESTS "Build protocol smoke tests" ON)

FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
)
FetchContent_MakeAvailable(nlohmann_json)

add_library(ag99_runtime_core
  src/protocol.cpp
  src/runtime_session.cpp
  src/segment_assembler.cpp
)

target_include_directories(ag99_runtime_core
  PUBLIC
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
