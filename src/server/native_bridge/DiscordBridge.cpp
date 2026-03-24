#include "DiscordBridge.hpp"

#include <iostream>

namespace dungeon_blitz::bridge {

DiscordBridge::DiscordBridge() = default;

DiscordBridge::~DiscordBridge() {
    // TODO: call Discord Social SDK shutdown / release handles.
    initialized_.store(false);
}

bool DiscordBridge::initialize(const DiscordBridgeConfig& config) {
    config_ = config;

    // TODO: Replace with real Discord Social SDK bootstrap, e.g.
    // discordpp::Client::Create(config.appId)
    client_ = reinterpret_cast<discordpp::Client*>(0x1);
    if (client_ == nullptr) {
        std::cerr << "[DiscordBridge] Failed to initialize Discord Social SDK client" << std::endl;
        return false;
    }

    bindDiscordEvents();
    initialized_.store(true);
    return true;
}

bool DiscordBridge::joinOrCreateLobby() {
    if (!initialized_.load()) {
        return false;
    }

    // TODO: replace with concrete SDK flow:
    // 1) Try JoinLobby(config_.lobbySecret)
    // 2) On failure CreateLobby()
    // 3) Set linked metadata channel_id=config_.linkedChannelId
    lobby_ = reinterpret_cast<discordpp::Lobby*>(0x1);
    return lobby_ != nullptr;
}

bool DiscordBridge::sendToLobby(const ChatMessage& message) {
    if (lobby_ == nullptr) {
        return false;
    }

    // TODO: use Discord Social SDK send lobby message call.
    std::cout << "[DiscordBridge -> Lobby] " << message.username << ": " << message.message << std::endl;
    return true;
}

void DiscordBridge::tick() {
    if (!initialized_.load()) {
        return;
    }

    // TODO: pump Discord SDK callbacks.
}

void DiscordBridge::setOnDiscordMessage(DiscordMessageCallback cb) {
    onDiscordMessage_ = std::move(cb);
}

void DiscordBridge::bindDiscordEvents() {
    // TODO: bind onLobbyMessageCreate / equivalent callback to handleIncomingDiscordMessage.
}

void DiscordBridge::handleIncomingDiscordMessage(const discordpp::Message& /*message*/) {
    if (!onDiscordMessage_) {
        return;
    }

    ChatMessage normalized {
        .playerId = 0,
        .username = "discord-user",
        .message = "placeholder-from-discord",
    };

    onDiscordMessage_(normalized);
}

} // namespace dungeon_blitz::bridge
