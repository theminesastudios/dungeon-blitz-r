#pragma once

#include "ChatTypes.hpp"

#include <atomic>
#include <functional>
#include <string>

namespace discordpp {
class Client;
class Lobby;
class Message;
} // namespace discordpp

namespace dungeon_blitz::bridge {

struct DiscordBridgeConfig {
    std::string appId;
    std::string lobbySecret;
    std::string linkedChannelId;
    std::string playerDisplayName;
};

class DiscordBridge {
  public:
    using DiscordMessageCallback = std::function<void(const ChatMessage&)>;

    DiscordBridge();
    ~DiscordBridge();

    bool initialize(const DiscordBridgeConfig& config);
    bool joinOrCreateLobby();
    bool sendToLobby(const ChatMessage& message);

    // Should be called from main server loop (or dedicated bridge thread).
    void tick();

    void setOnDiscordMessage(DiscordMessageCallback cb);

  private:
    void bindDiscordEvents();
    void handleIncomingDiscordMessage(const discordpp::Message& message);

    DiscordBridgeConfig config_;
    DiscordMessageCallback onDiscordMessage_;
    std::atomic<bool> initialized_ { false };

    // Placeholder pointers; replace with concrete discord_social_sdk types.
    discordpp::Client* client_ { nullptr };
    discordpp::Lobby* lobby_ { nullptr };
};

} // namespace dungeon_blitz::bridge
