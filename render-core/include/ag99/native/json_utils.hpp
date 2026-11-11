#pragma once

#include <initializer_list>
#include <string>

#include "ag99/runtime/protocol.hpp"

namespace ag99::native::json {

double ReadNumber(
    const ag99::runtime::Json& object,
    const char* key,
    double fallback);

std::string ReadString(
    const ag99::runtime::Json& object,
    const char* key);

bool HasOnlyKeys(
    const ag99::runtime::Json& object,
    std::initializer_list<const char*> keys);

bool IsFiniteNumber(const ag99::runtime::Json& value);

bool IsIntegerInRange(
    const ag99::runtime::Json& value,
    int minimum,
    int maximum);

}  // namespace ag99::native::json
