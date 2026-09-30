#include "ag99/runtime/protocol.hpp"
#include "ag99/runtime/segment_assembler.hpp"

#include <fstream>
#include <iostream>
#include <string>

namespace {

ag99::runtime::Json sample_segment() {
  return {
      {"type", "output.segment"},
      {"version", "v2"},
      {"message_id", "sample-message-1"},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", "sample-turn-1"},
      {"source", "adapter"},
      {"payload",
       {
           {"schema_version", "output.segment.v5"},
           {"sequence", 0},
           {"text", {{"state", "present"}, {"content", "协议回放正常。"}}},
           {"audio", {{"state", "absent"}}},
           {"motion", {{"state", "absent"}}},
           {"speech", {{"state", "absent"}}},
           {"images", nlohmann::json::array()},
           {"speaker_name", "assistant"},
           {"avatar", ""},
       }},
  };
}

void process_line(
    std::string_view line,
    ag99::runtime::SegmentAssembler& assembler) {
  if (line.empty()) {
    return;
  }
  try {
    const auto envelope = ag99::runtime::parse_envelope_json(line);
    if (envelope.type != "output.segment") {
      std::cout << "ignored type=" << envelope.type << "\n";
      return;
    }
    auto segment = ag99::runtime::parse_output_segment(envelope);
    const auto result = assembler.ingest(std::move(segment));
    if (!result.accepted) {
      std::cerr << "rejected segment: " << result.reason << "\n";
      return;
    }
    for (const auto& ready : result.ready) {
      std::cout << "ready " << ag99::runtime::describe_segment(ready) << "\n";
    }
  } catch (const std::exception& error) {
    std::cerr << "protocol error: " << error.what() << "\n";
  }
}

}  // namespace

int main(int argc, char** argv) {
  ag99::runtime::SegmentAssembler assembler;
  if (argc == 1) {
    process_line(sample_segment().dump(), assembler);
    return 0;
  }
  std::ifstream input(argv[1]);
  if (!input) {
    std::cerr << "unable to open replay file: " << argv[1] << "\n";
    return 2;
  }
  std::string line;
  while (std::getline(input, line)) {
    process_line(line, assembler);
  }
  return 0;
}
