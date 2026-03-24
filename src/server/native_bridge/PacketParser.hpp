#pragma once

#include "ChatTypes.hpp"

#include <cstdint>
#include <optional>
#include <span>

namespace dungeon_blitz::bridge {

// Mock packet schema for public chat until protocol captures are finalized.
// Big-endian wire layout:
// [u16 packetId][u32 playerId][u8 usernameLen][username bytes][u16 messageLen][message bytes]
class PacketParser {
  public:
    static constexpr std::uint16_t kPublicChatPacketId = 0x002C;

    std::optional<ChatMessage> parsePublicChat(std::span<const std::uint8_t> packet) const;
};

} // namespace dungeon_blitz::bridge
