#include "ChatHandler.hpp"

namespace dungeon_blitz::bridge {

ChatHandler::ChatHandler(PacketParser parser, DiscordBridge& discordBridge, IGameBroadcaster& gameBroadcaster)
    : parser_(std::move(parser)), discordBridge_(discordBridge), gameBroadcaster_(gameBroadcaster) {}

void ChatHandler::onIncomingPacket(std::span<const std::uint8_t> packet) {
    const auto parsedChat = parser_.parsePublicChat(packet);
    if (!parsedChat) {
        return;
    }

    // Existing behavior: rebroadcast to in-game peers.
    gameBroadcaster_.broadcastGameChat(*parsedChat);

    // New behavior: relay same normalized event to Discord lobby.
    discordBridge_.sendToLobby(*parsedChat);
}

void ChatHandler::onDiscordChat(const ChatMessage& message) {
    // Incoming Discord -> game clients.
    gameBroadcaster_.broadcastGameChat(message);
}

} // namespace dungeon_blitz::bridge
