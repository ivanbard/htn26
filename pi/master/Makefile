CXX ?= g++
BUILD_DIR ?= /tmp/htn26-master-build
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Wpedantic -pthread
CPPFLAGS += -I../..

COMMON_OBJ := $(BUILD_DIR)/protocol.o
ENGINE_OBJ := $(BUILD_DIR)/master_engine.o
TEST_BIN := $(BUILD_DIR)/htn26_master_tests
SERVER_BIN := $(BUILD_DIR)/htn26_master_server

.PHONY: all test server smoke clean

all: $(TEST_BIN) $(SERVER_BIN)

test: $(TEST_BIN)
	$(TEST_BIN)

server: $(SERVER_BIN)

smoke: $(SERVER_BIN)
	printf '%s\n' 'HTN26|GW|UP|1|0' | $(SERVER_BIN) AA:BB:CC:DD:EE:FF

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(COMMON_OBJ): ../common/protocol.cpp ../common/protocol.hpp | $(BUILD_DIR)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -c $< -o $@

$(ENGINE_OBJ): src/master_engine.cpp src/master_engine.hpp ../common/protocol.hpp | $(BUILD_DIR)
	$(CXX) $(CPPFLAGS) -Isrc $(CXXFLAGS) -c $< -o $@

$(TEST_BIN): tests/master_engine_test.cpp $(ENGINE_OBJ) $(COMMON_OBJ) | $(BUILD_DIR)
	$(CXX) $(CPPFLAGS) -Isrc $(CXXFLAGS) $< $(ENGINE_OBJ) $(COMMON_OBJ) -o $@

$(SERVER_BIN): src/server_main.cpp $(ENGINE_OBJ) $(COMMON_OBJ) | $(BUILD_DIR)
	$(CXX) $(CPPFLAGS) -Isrc $(CXXFLAGS) $< $(ENGINE_OBJ) $(COMMON_OBJ) -o $@

clean:
	rm -rf $(BUILD_DIR)
