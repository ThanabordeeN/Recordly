cmake_minimum_required(VERSION 3.20)
project(recordly-wayland-cursor LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "recordly-wayland-cursor only builds on Linux")
endif()

find_package(PkgConfig REQUIRED)
pkg_check_modules(SYSTEMD REQUIRED IMPORTED_TARGET libsystemd)

add_executable(recordly-wayland-cursor src/main.cpp src/libinput_buttons.cpp)

# libinput is dlopen()ed at runtime rather than linked, so no libinput-devel is
# needed to build and a machine without the library degrades to
# "button capture unavailable" instead of failing to start.
target_link_libraries(recordly-wayland-cursor PRIVATE PkgConfig::SYSTEMD ${CMAKE_DL_LIBS})
