CXX ?= g++
BUILD_DIR ?= /tmp/htn26-master-build
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Wpedantic
CPPFLAGS += -I../..

COMMON_OBJ := $(BUILD_DIR)/protocol.o
ENGINE_OBJ := $(BUILD_DIR)/master_engine.o
TEST_BIN := $(BUILD_DIR)/htn26_master_tests

.PHONY: all test clean

all: $(TEST_BIN)

test: $(TEST_BIN)
	$(TEST_BIN)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(COMMON_OBJ): ../common/protocol.cpp ../common/protocol.hpp | $(BUILD_DIR)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -c $< -o $@

$(ENGINE_OBJ): src/master_engine.cpp src/master_engine.hpp ../common/protocol.hpp | $(BUILD_DIR)
	$(CXX) $(CPPFLAGS) -Isrc $(CXXFLAGS) -c $< -o $@

$(TEST_BIN): tests/master_engine_test.cpp $(ENGINE_OBJ) $(COMMON_OBJ) | $(BUILD_DIR)
	$(CXX) $(CPPFLAGS) -Isrc $(CXXFLAGS) $< $(ENGINE_OBJ) $(COMMON_OBJ) -o $@

clean:
	rm -rf $(BUILD_DIR)
