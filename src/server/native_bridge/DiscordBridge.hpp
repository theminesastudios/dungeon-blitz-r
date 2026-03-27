#pragma once

#include "ChatTypes.hpp"
#include "discord_social_sdk/include/discordpp.h"

#include <atomic>
#include <functional>
#include <optional>
#include <thread>
#include <string>

namespace dungeon_blitz::bridge {

struct DiscordBridgeConfig {
    std::string appId;
    std::string lobbySecret;
    std::string linkedChannelId;
    std::string playerDisplayName;
    std::string tokenCachePath;
    bool useDeviceFlow { true };
    bool enableChannelLinking { false };
};

struct DeviceAuthorizationInfo {
    std::string verificationUri;
    std::string userCode;
};

class DiscordBridge {
  public:
    using DiscordMessageCallback = std::function<void(const ChatMessage&)>;

    DiscordBridge();
    ~DiscordBridge();

    bool initialize(const DiscordBridgeConfig& config);
    bool tryRestoreSession();
    std::optional<DeviceAuthorizationInfo> beginDeviceAuthorization();
    bool joinOrCreateLobby();
    bool linkChannelToLobby(const std::string& lobbyId, const std::string& channelId);
    bool sendToLobby(const ChatMessage& message);

    // Should be called from main server loop (or dedicated bridge thread).
    void tick();

    void setOnDiscordMessage(DiscordMessageCallback cb);

  private:
    void bindDiscordEvents();
    void handleIncomingDiscordMessage(const discordpp::MessageHandle& message);
    void startCallbackPump();
    void stopCallbackPump();
    std::string buildLobbySecret() const;
    void connectWithToken(discordpp::AuthorizationTokenType tokenType, const std::string& accessToken);
    bool loadCachedTokens();
    void persistTokens() const;
    void clearCachedTokens() const;

    DiscordBridgeConfig config_;
    DiscordMessageCallback onDiscordMessage_;
    std::atomic<bool> initialized_ { false };
    std::atomic<bool> lobbyReady_ { false };
    std::atomic<bool> clientReady_ { false };
    std::atomic<bool> authInFlight_ { false };
    std::atomic<bool> callbackPumpRunning_ { false };
    std::thread callbackPumpThread_;
    std::string accessToken_;
    std::string refreshToken_;
    std::string pkceVerifier_;
    std::uint64_t lobbyId_ { 0 };

    discordpp::Client* client_ { nullptr };
};

} // namespace dungeon_blitz::bridge
