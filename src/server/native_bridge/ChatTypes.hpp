#pragma once

#include <cstdint>
#include <string>

namespace dungeon_blitz::bridge {

struct ChatMessage {
    std::uint64_t playerId;
    std::uint64_t channelId;
    std::uint64_t messageId;
    std::uint64_t sentTimestamp;
    std::string username;
    std::string message;
    std::string rawMessage;
};

} // namespace dungeon_blitz::bridge
