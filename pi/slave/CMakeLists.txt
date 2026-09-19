cmake_minimum_required(VERSION 3.16)
project(htn26_camera_worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(camera_worker_core
  src/worker_core.cpp
)
target_include_directories(camera_worker_core PUBLIC include)
target_compile_options(camera_worker_core PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic>
)

add_executable(worker_demo src/worker_demo.cpp)
target_link_libraries(worker_demo PRIVATE camera_worker_core)

add_executable(worker_core_tests tests/worker_core_tests.cpp)
target_link_libraries(worker_core_tests PRIVATE camera_worker_core)

enable_testing()
add_test(NAME worker_core_tests COMMAND worker_core_tests)
