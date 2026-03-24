#pragma once

#include "ChatTypes.hpp"
#include "DiscordBridge.hpp"
#include "PacketParser.hpp"

#include <cstdint>
#include <span>

namespace dungeon_blitz::bridge {

class IGameBroadcaster {
  public:
    virtual ~IGameBroadcaster() = default;
    virtual void broadcastGameChat(const ChatMessage& message) = 0;
};

class ChatHandler {
  public:
    ChatHandler(PacketParser parser, DiscordBridge& discordBridge, IGameBroadcaster& gameBroadcaster);

    // Called by socket server for every client packet.
    void onIncomingPacket(std::span<const std::uint8_t> packet);

    // Called when Discord lobby emits a message.
    void onDiscordChat(const ChatMessage& message);

  private:
    PacketParser parser_;
    DiscordBridge& discordBridge_;
    IGameBroadcaster& gameBroadcaster_;
};

} // namespace dungeon_blitz::bridge
