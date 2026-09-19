cmake_minimum_required(VERSION 3.16)
project(htn26_master LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(htn26_common STATIC
  ../common/protocol.cpp
)
target_include_directories(htn26_common PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/../..
)
target_compile_options(htn26_common PRIVATE -Wall -Wextra -Wpedantic)

add_library(htn26_master_core STATIC
  src/master_engine.cpp
)
target_include_directories(htn26_master_core PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/../..
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)
target_link_libraries(htn26_master_core PUBLIC htn26_common)
target_compile_options(htn26_master_core PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
add_executable(htn26_master_tests
  tests/master_engine_test.cpp
)
target_link_libraries(htn26_master_tests PRIVATE htn26_master_core)
target_compile_options(htn26_master_tests PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME htn26_master_tests COMMAND htn26_master_tests)
