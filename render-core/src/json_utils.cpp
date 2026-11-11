#include <cmath>

#include "ag99/native/json_utils.hpp"

namespace ag99::native::json {

double ReadNumber(
    const ag99::runtime::Json& object,
    const char* key,
    double fallback) {
  const auto it = object.find(key);
  return it != object.end() && it->is_number()
      ? it->get<double>() : fallback;
}

std::string ReadString(
    const ag99::runtime::Json& object,
    const char* key) {
  const auto it = object.find(key);
  return it != object.end() && it->is_string()
      ? it->get<std::string>() : std::string{};
}

bool HasOnlyKeys(
    const ag99::runtime::Json& object,
    std::initializer_list<const char*> keys) {
  if (!object.is_object()) {
    return false;
  }
  for (const auto& [key, _] : object.items()) {
    bool allowed = false;
    for (const auto* candidate : keys) {
      if (key == candidate) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      return false;
    }
  }
  return true;
}

bool IsFiniteNumber(const ag99::runtime::Json& value) {
  return value.is_number() && std::isfinite(value.get<double>());
}

bool IsIntegerInRange(
    const ag99::runtime::Json& value,
    int minimum,
    int maximum) {
  return value.is_number_integer()
      && value.get<std::int64_t>() >= minimum
      && value.get<std::int64_t>() <= maximum;
}

}  // namespace ag99::native::json
