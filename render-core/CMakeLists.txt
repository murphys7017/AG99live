cmake_minimum_required(VERSION 3.20)

project(ag99_render_core LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "render-core currently supports Windows only")
endif()

set(CUBISM_SDK_ROOT "" CACHE PATH
  "CubismSdkForNative root directory")
if(NOT CUBISM_SDK_ROOT)
  message(FATAL_ERROR
    "Set -DCUBISM_SDK_ROOT=<path to CubismSdkForNative-5-r.5>")
endif()

set(CUBISM_CORE_PATH "${CUBISM_SDK_ROOT}/Core")
set(CUBISM_FRAMEWORK_PATH "${CUBISM_SDK_ROOT}/Framework")
set(DIRECTXTK_PATH "${CUBISM_SDK_ROOT}/Samples/D3D11/thirdParty/DirectXTK")

if(NOT EXISTS "${CUBISM_CORE_PATH}/include/Live2DCubismCore.h")
  message(FATAL_ERROR "Cubism Core was not found under ${CUBISM_CORE_PATH}")
endif()
if(NOT EXISTS "${DIRECTXTK_PATH}/Inc")
  message(FATAL_ERROR "DirectXTK was not found under ${DIRECTXTK_PATH}")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CONFIGURATION_TYPES Debug Release CACHE STRING "" FORCE)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")

add_library(ag99_cubism_core STATIC IMPORTED GLOBAL)
set_target_properties(ag99_cubism_core PROPERTIES
  IMPORTED_LOCATION_DEBUG
    "${CUBISM_CORE_PATH}/lib/windows/x86_64/143/Live2DCubismCore_MDd.lib"
  IMPORTED_LOCATION_RELEASE
    "${CUBISM_CORE_PATH}/lib/windows/x86_64/143/Live2DCubismCore_MD.lib"
  INTERFACE_INCLUDE_DIRECTORIES "${CUBISM_CORE_PATH}/include"
)

add_library(ag99_directxtk STATIC IMPORTED GLOBAL)
set_target_properties(ag99_directxtk PROPERTIES
  IMPORTED_LOCATION_DEBUG
    "${DIRECTXTK_PATH}/Bin/Desktop_2022/x64/Debug/DirectXTK.lib"
  IMPORTED_LOCATION_RELEASE
    "${DIRECTXTK_PATH}/Bin/Desktop_2022/x64/Release/DirectXTK.lib"
  INTERFACE_INCLUDE_DIRECTORIES "${DIRECTXTK_PATH}/Inc"
)

add_executable(ag99-render-host WIN32
  src/main.cpp
)

set(FRAMEWORK_SOURCE D3D11)
add_subdirectory("${CUBISM_FRAMEWORK_PATH}"
  "${CMAKE_CURRENT_BINARY_DIR}/cubism-framework")
set_target_properties(Framework PROPERTIES EXCLUDE_FROM_ALL TRUE)
target_include_directories(Framework PUBLIC "${DIRECTXTK_PATH}/Inc")
target_link_libraries(Framework PRIVATE
  ag99_cubism_core
  ag99_directxtk
  d3d11
  d3dcompiler
)

target_compile_definitions(ag99-render-host PRIVATE
  UNICODE
  _UNICODE
  NOMINMAX
  WIN32_LEAN_AND_MEAN
)
target_include_directories(ag99-render-host PRIVATE
  "${CUBISM_CORE_PATH}/include"
  "${CUBISM_FRAMEWORK_PATH}/src"
  "${DIRECTXTK_PATH}/Inc"
)
target_link_libraries(ag99-render-host PRIVATE
  Framework
  ag99_cubism_core
  ag99_directxtk
  d3d11
  d3dcompiler
  dwmapi
  shell32
)
