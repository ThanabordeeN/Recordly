cmake_minimum_required(VERSION 3.20)
project(recordly-wayland-capture LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "recordly-wayland-capture only builds on Linux")
endif()

find_package(PkgConfig REQUIRED)
pkg_check_modules(SYSTEMD REQUIRED IMPORTED_TARGET libsystemd)

add_executable(recordly-wayland-capture src/main.cpp src/portal.cpp)
target_link_libraries(recordly-wayland-capture PRIVATE PkgConfig::SYSTEMD)
