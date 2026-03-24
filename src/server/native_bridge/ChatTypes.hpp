#pragma once

#include <cstdint>
#include <string>

namespace dungeon_blitz::bridge {

struct ChatMessage {
    std::uint64_t playerId;
    std::string username;
    std::string message;
};

} // namespace dungeon_blitz::bridge
