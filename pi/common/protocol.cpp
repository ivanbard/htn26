#include "pi/common/protocol.hpp"

#include <algorithm>
#include <cctype>
#include <limits>
#include <sstream>

namespace htn26::protocol {
namespace {

std::string trim(std::string_view input) {
  std::size_t begin = 0;
  while (begin < input.size() &&
         std::isspace(static_cast<unsigned char>(input[begin])) != 0) {
    ++begin;
  }
  std::size_t end = input.size();
  while (end > begin &&
         std::isspace(static_cast<unsigned char>(input[end - 1])) != 0) {
    --end;
  }
  return std::string(input.substr(begin, end - begin));
}

std::vector<std::string> split(std::string_view input) {
  std::vector<std::string> fields;
  std::size_t start = 0;
  while (start <= input.size()) {
    const std::size_t separator = input.find('|', start);
    if (separator == std::string_view::npos) {
      fields.emplace_back(input.substr(start));
      break;
    }
    fields.emplace_back(input.substr(start, separator - start));
    start = separator + 1;
  }
  return fields;
}

bool parse_unsigned(std::string_view text, std::uint64_t maximum,
                    std::uint64_t &value) {
  if (text.empty()) {
    return false;
  }
  std::uint64_t parsed = 0;
  for (const char character : text) {
    if (character < '0' || character > '9') {
      return false;
    }
    const auto digit = static_cast<std::uint64_t>(character - '0');
    if (parsed > (maximum - digit) / 10) {
      return false;
    }
    parsed = parsed * 10 + digit;
  }
  value = parsed;
  return true;
}

bool parse_signed(std::string_view text, int minimum, int maximum, int &value) {
  if (text.empty()) {
    return false;
  }
  std::size_t offset = 0;
  bool negative = false;
  if (text.front() == '-' || text.front() == '+') {
    negative = text.front() == '-';
    offset = 1;
  }
  if (offset == text.size()) {
    return false;
  }
  std::uint64_t magnitude = 0;
  if (!parse_unsigned(
          text.substr(offset),
          static_cast<std::uint64_t>(std::numeric_limits<int>::max()),
          magnitude)) {
    return false;
  }
  const long long signed_value = negative ? -static_cast<long long>(magnitude)
                                          : static_cast<long long>(magnitude);
  if (signed_value < minimum || signed_value > maximum) {
    return false;
  }
  value = static_cast<int>(signed_value);
  return true;
}

bool printable_value(std::string_view value) {
  if (value.empty()) {
    return false;
  }
  for (const char raw_character : value) {
    const auto character = static_cast<unsigned char>(raw_character);
    if (character < 0x20 || character > 0x7e || character == '|') {
      return false;
    }
  }
  return true;
}

bool is_hex(char character) {
  return (character >= '0' && character <= '9') ||
         (character >= 'a' && character <= 'f') ||
         (character >= 'A' && character <= 'F');
}

char upper_hex(char character) {
  if (character >= 'a' && character <= 'f') {
    return static_cast<char>(character - 'a' + 'A');
  }
  return character;
}

} // namespace

bool is_valid_mac(std::string_view mac) {
  if (mac.size() != 17) {
    return false;
  }
  for (std::size_t index = 0; index < mac.size(); ++index) {
    if (index % 3 == 2) {
      if (mac[index] != ':') {
        return false;
      }
    } else if (!is_hex(mac[index])) {
      return false;
    }
  }
  return true;
}

std::string normalize_mac(std::string_view mac) {
  if (!is_valid_mac(mac)) {
    return {};
  }
  std::string normalized(mac);
  for (char &character : normalized) {
    character = upper_hex(character);
  }
  return normalized;
}

ParseResult parse_gateway_rx_line(std::string_view line) {
  ParseResult result;
  const std::size_t marker = line.find("HTN26|");
  if (marker == std::string_view::npos) {
    result.error = "missing HTN26 marker";
    return result;
  }

  const std::string payload = trim(line.substr(marker));
  const std::vector<std::string> fields = split(payload);
  if (fields.size() != 8 || fields[0] != "HTN26" || fields[1] != "RX") {
    result.error = "invalid RX field count or prefix";
    return result;
  }
  if (!is_valid_mac(fields[2])) {
    result.error = "invalid sender MAC";
    return result;
  }

  int rssi = 0;
  if (!parse_signed(fields[3], -127, 20, rssi)) {
    result.error = "invalid RSSI";
    return result;
  }
  if (fields[4] != "OC1") {
    result.error = "unsupported badge protocol";
    return result;
  }

  std::uint64_t sequence = 0;
  if (!parse_unsigned(fields[5], kMaxBadgeSequence, sequence)) {
    result.error = "invalid badge sequence";
    return result;
  }
  if (fields[6].size() != 1 || (fields[6][0] != 'N' && fields[6][0] != 'M' &&
                                fields[6][0] != 'B' && fields[6][0] != 'H')) {
    result.error = "invalid badge event type";
    return result;
  }
  if (!printable_value(fields[7])) {
    result.error = "invalid badge value";
    return result;
  }

  const std::string canonical_payload =
      fields[4] + "|" + fields[5] + "|" + fields[6] + "|" + fields[7];
  if (canonical_payload.size() > kMaxBadgePayloadBytes) {
    result.error = "badge payload exceeds 44 bytes";
    return result;
  }

  result.ok = true;
  result.intent.sender_mac = normalize_mac(fields[2]);
  result.intent.rssi = rssi;
  result.intent.sequence = static_cast<std::uint32_t>(sequence);
  result.intent.type = fields[6][0];
  result.intent.value = fields[7];
  return result;
}

GatewayStatusParseResult parse_gateway_status_line(std::string_view line) {
  GatewayStatusParseResult result;
  const std::size_t marker = line.find("HTN26|");
  if (marker == std::string_view::npos) {
    result.error = "missing HTN26 marker";
    return result;
  }

  const std::string payload = trim(line.substr(marker));
  const std::vector<std::string> fields = split(payload);
  if (fields.size() != 5 || fields[0] != "HTN26" || fields[1] != "GW") {
    result.error = "invalid gateway status field count or prefix";
    return result;
  }
  if (fields[2] != "UP" && fields[2] != "DOWN") {
    result.error = "invalid gateway status";
    return result;
  }
  std::uint64_t packets = 0;
  std::uint64_t dropped = 0;
  if (!parse_unsigned(fields[3], std::numeric_limits<std::uint64_t>::max(),
                      packets) ||
      !parse_unsigned(fields[4], std::numeric_limits<std::uint64_t>::max(),
                      dropped)) {
    result.error = "invalid gateway counters";
    return result;
  }

  result.ok = true;
  result.status.up = fields[2] == "UP";
  result.status.packet_count = packets;
  result.status.dropped_count = dropped;
  return result;
}

} // namespace htn26::protocol
