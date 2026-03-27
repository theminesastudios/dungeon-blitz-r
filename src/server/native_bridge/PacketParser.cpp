#include "PacketParser.hpp"

#include <cstddef>

namespace dungeon_blitz::bridge {
namespace {

std::optional<std::uint16_t> readU16(std::span<const std::uint8_t> data, std::size_t& cursor) {
    if (cursor + 2 > data.size()) {
        return std::nullopt;
    }

    const auto value = static_cast<std::uint16_t>(data[cursor] << 8U) |
                       static_cast<std::uint16_t>(data[cursor + 1]);
    cursor += 2;
    return value;
}

std::optional<std::uint32_t> readU32(std::span<const std::uint8_t> data, std::size_t& cursor) {
    if (cursor + 4 > data.size()) {
        return std::nullopt;
    }

    const auto value = (static_cast<std::uint32_t>(data[cursor]) << 24U) |
                       (static_cast<std::uint32_t>(data[cursor + 1]) << 16U) |
                       (static_cast<std::uint32_t>(data[cursor + 2]) << 8U) |
                       static_cast<std::uint32_t>(data[cursor + 3]);

    cursor += 4;
    return value;
}

std::optional<std::string> readString8(std::span<const std::uint8_t> data, std::size_t& cursor) {
    if (cursor + 1 > data.size()) {
        return std::nullopt;
    }

    const auto len = static_cast<std::size_t>(data[cursor]);
    cursor += 1;

    if (cursor + len > data.size()) {
        return std::nullopt;
    }

    std::string value(reinterpret_cast<const char*>(data.data() + cursor), len);
    cursor += len;
    return value;
}

std::optional<std::string> readString16(std::span<const std::uint8_t> data, std::size_t& cursor) {
    const auto len = readU16(data, cursor);
    if (!len) {
        return std::nullopt;
    }

    if (cursor + *len > data.size()) {
        return std::nullopt;
    }

    std::string value(reinterpret_cast<const char*>(data.data() + cursor), *len);
    cursor += *len;
    return value;
}

} // namespace

std::optional<ChatMessage> PacketParser::parsePublicChat(std::span<const std::uint8_t> packet) const {
    std::size_t cursor = 0;

    const auto packetId = readU16(packet, cursor);
    if (!packetId || *packetId != kPublicChatPacketId) {
        return std::nullopt;
    }

    const auto playerId = readU32(packet, cursor);
    const auto username = readString8(packet, cursor);
    const auto message = readString16(packet, cursor);
    if (!playerId || !username || !message) {
        return std::nullopt;
    }

    return ChatMessage {
        .playerId = *playerId,
        .username = *username,
        .message = *message,
    };
}

} // namespace dungeon_blitz::bridge
