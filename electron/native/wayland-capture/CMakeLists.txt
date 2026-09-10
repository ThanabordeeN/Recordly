cmake_minimum_required(VERSION 3.20)
project(recordly-wayland-capture LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "recordly-wayland-capture only builds on Linux")
endif()

find_package(PkgConfig REQUIRED)
pkg_check_modules(SYSTEMD REQUIRED IMPORTED_TARGET libsystemd)
pkg_check_modules(GST REQUIRED IMPORTED_TARGET gstreamer-1.0 gstreamer-app-1.0)

# Shared in-process capture engine + lifecycle runner.
set(CAPTURE_COMMON_SOURCES
    src/gst_capture.cpp
    src/capture_runner.cpp)

# Production helper: negotiates its own desktop-portal session.
add_executable(recordly-wayland-capture
    src/main.cpp
    src/portal.cpp
    ${CAPTURE_COMMON_SOURCES})
target_link_libraries(recordly-wayland-capture PRIVATE
    PkgConfig::SYSTEMD
    PkgConfig::GST)

# Generated-source fixture: same engine, no portal or real devices.
add_executable(recordly-wayland-capture-fixture
    src/fixture_main.cpp
    src/generated_source.cpp
    ${CAPTURE_COMMON_SOURCES})
target_link_libraries(recordly-wayland-capture-fixture PRIVATE
    PkgConfig::GST)

# Pure timeline math test (no desktop, no GStreamer devices).
add_executable(capture_timeline_test
    tests/capture_timeline_test.cpp)
target_include_directories(capture_timeline_test PRIVATE src)
target_link_libraries(capture_timeline_test PRIVATE PkgConfig::GST)
