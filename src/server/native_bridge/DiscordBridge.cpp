#include "DiscordBridge.hpp"

#define DISCORDPP_IMPLEMENTATION
#include "discord_social_sdk/include/discordpp.h"

#include <chrono>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <unordered_map>

namespace dungeon_blitz::bridge {
namespace {

std::optional<std::string> extractJsonField(const std::string& json, const std::string& key) {
    const auto token = "\"" + key + "\"";
    const auto keyPos = json.find(token);
    if (keyPos == std::string::npos) {
        return std::nullopt;
    }

    const auto colonPos = json.find(':', keyPos + token.size());
    if (colonPos == std::string::npos) {
        return std::nullopt;
    }

    const auto quotePos = json.find('"', colonPos + 1);
    if (quotePos == std::string::npos) {
        return std::nullopt;
    }

    std::string value;
    bool escaped = false;
    for (std::size_t i = quotePos + 1; i < json.size(); ++i) {
        const char ch = json[i];
        if (escaped) {
            value.push_back(ch);
            escaped = false;
            continue;
        }

        if (ch == '\\') {
            escaped = true;
            continue;
        }

        if (ch == '"') {
            return value;
        }

        value.push_back(ch);
    }

    return std::nullopt;
}

std::string jsonEscape(const std::string& value) {
    std::ostringstream out;
    for (const char ch : value) {
        switch (ch) {
            case '\\':
                out << "\\\\";
                break;
            case '"':
                out << "\\\"";
                break;
            case '\n':
                out << "\\n";
                break;
            case '\r':
                out << "\\r";
                break;
            case '\t':
                out << "\\t";
                break;
            default:
                out << ch;
                break;
        }
    }

    return out.str();
}

std::string resolveUserName(const discordpp::UserHandle& user) {
    const auto globalName = user.GlobalName();
    const auto displayName = user.DisplayName();
    const auto handle = user.Username();

    if (globalName && !globalName->empty()) {
        return *globalName;
    }

    if (!displayName.empty()) {
        return displayName;
    }

    if (!handle.empty()) {
        return handle;
    }

    return "";
}

} // namespace

DiscordBridge::DiscordBridge() = default;

DiscordBridge::~DiscordBridge() {
    stopCallbackPump();
    delete client_;
    client_ = nullptr;
    initialized_.store(false);
}

bool DiscordBridge::initialize(const DiscordBridgeConfig& config) {
    config_ = config;

    delete client_;
    client_ = new discordpp::Client();
    if (client_ == nullptr) {
        std::cerr << "[DiscordBridge] Failed to initialize Discord Social SDK client" << std::endl;
        return false;
    }

    client_->SetApplicationId(std::strtoull(config_.appId.c_str(), nullptr, 10));
    client_->AddLogCallback(
        [](std::string message, discordpp::LoggingSeverity) {
            std::cerr << "[DiscordSDK] " << message << std::endl;
        },
        discordpp::LoggingSeverity::Info
    );

    bindDiscordEvents();
    startCallbackPump();
    initialized_.store(true);
    return true;
}

bool DiscordBridge::tryRestoreSession() {
    if (!initialized_.load() || client_ == nullptr) {
        return false;
    }

    if (!loadCachedTokens()) {
        return false;
    }

    if (!accessToken_.empty()) {
        connectWithToken(discordpp::AuthorizationTokenType::Bearer, accessToken_);
        return true;
    }

    if (!refreshToken_.empty()) {
        client_->RefreshToken(
            std::strtoull(config_.appId.c_str(), nullptr, 10),
            refreshToken_,
            [this](
                discordpp::ClientResult result,
                std::string accessToken,
                std::string refreshToken,
                discordpp::AuthorizationTokenType tokenType,
                int32_t,
                std::string
            ) {
                if (!result.Successful()) {
                    std::cerr << "[DiscordBridge] RefreshToken failed: " << result.ToString() << std::endl;
                    clearCachedTokens();
                    return;
                }

                accessToken_ = std::move(accessToken);
                refreshToken_ = std::move(refreshToken);
                persistTokens();
                connectWithToken(tokenType, accessToken_);
            }
        );
        return true;
    }

    return false;
}

std::optional<DeviceAuthorizationInfo> DiscordBridge::beginDeviceAuthorization() {
    if (!initialized_.load() || client_ == nullptr || authInFlight_.exchange(true)) {
        return std::nullopt;
    }

    const auto applicationId = std::strtoull(config_.appId.c_str(), nullptr, 10);
    const auto completeTokenExchange =
        [this](
            discordpp::ClientResult result,
            std::string accessToken,
            std::string refreshToken,
            discordpp::AuthorizationTokenType tokenType,
            int32_t,
            std::string
        ) {
            authInFlight_.store(false);
            if (!result.Successful()) {
                std::cerr << "[DiscordBridge] Device authorization failed: " << result.ToString() << std::endl;
                return;
            }

            accessToken_ = std::move(accessToken);
            refreshToken_ = std::move(refreshToken);
            persistTokens();
            connectWithToken(tokenType, accessToken_);
        };

    bool useDeviceFlow = config_.useDeviceFlow;
#if !defined(__APPLE__)
    if (!useDeviceFlow) {
        std::cerr << "[DiscordBridge] PKCE/browser authorization is not implemented on this platform. Falling back to device flow." << std::endl;
        useDeviceFlow = true;
    }
#endif

    if (useDeviceFlow) {
        discordpp::DeviceAuthorizationArgs args {};
        args.SetClientId(applicationId);
        args.SetScopes(discordpp::Client::GetDefaultCommunicationScopes());

        client_->GetTokenFromDevice(args, completeTokenExchange);
        return std::nullopt;
    }

#if defined(__APPLE__)
    auto verifier = client_->CreateAuthorizationCodeVerifier();
    pkceVerifier_ = verifier.Verifier();

    discordpp::AuthorizationArgs args {};
    args.SetClientId(applicationId);
    args.SetScopes(discordpp::Client::GetDefaultCommunicationScopes());
    args.SetCodeChallenge(verifier.Challenge());

    client_->Authorize(
        args,
        [this, applicationId](discordpp::ClientResult result, std::string code, std::string redirectUri) {
            if (!result.Successful()) {
                authInFlight_.store(false);
                std::cerr << "[DiscordBridge] Authorize failed: " << result.ToString() << std::endl;
                return;
            }

            client_->GetToken(
                applicationId,
                code,
                pkceVerifier_,
                redirectUri,
                [this](
                    discordpp::ClientResult tokenResult,
                    std::string accessToken,
                    std::string refreshToken,
                    discordpp::AuthorizationTokenType tokenType,
                    int32_t,
                    std::string
                ) {
                    authInFlight_.store(false);
                    if (!tokenResult.Successful()) {
                        std::cerr << "[DiscordBridge] GetToken failed: " << tokenResult.ToString() << std::endl;
                        return;
                    }

                    accessToken_ = std::move(accessToken);
                    refreshToken_ = std::move(refreshToken);
                    persistTokens();
                    connectWithToken(tokenType, accessToken_);
                }
            );
        }
    );

    return std::nullopt;
#else
    authInFlight_.store(false);
    std::cerr << "[DiscordBridge] PKCE/browser authorization is not implemented on this platform." << std::endl;
    return std::nullopt;
#endif
}

bool DiscordBridge::joinOrCreateLobby() {
    if (!initialized_.load() || client_ == nullptr || !clientReady_.load()) {
        return false;
    }

    const auto secret = buildLobbySecret();
    client_->CreateOrJoinLobby(
        secret,
        [this](discordpp::ClientResult result, std::uint64_t lobbyId) {
            if (!result.Successful()) {
                std::cerr << "[DiscordBridge] CreateOrJoinLobby failed: " << result.ToString() << std::endl;
                return;
            }

            lobbyId_ = lobbyId;
            lobbyReady_.store(lobbyId_ != 0);

            if (config_.enableChannelLinking) {
                auto currentUser = client_->GetCurrentUserV2();
                if (currentUser) {
                    std::cout << "{\"type\":\"lobby_ready\",\"lobbyId\":\"" << lobbyId_
                              << "\",\"userId\":\"" << currentUser->Id() << "\"}" << std::endl;
                }
            } else if (!config_.linkedChannelId.empty()) {
                std::cerr << "[DiscordBridge] Channel linking disabled; lobby chat will stay in SDK lobby only." << std::endl;
            }
        }
    );

    return true;
}

bool DiscordBridge::linkChannelToLobby(const std::string& lobbyId, const std::string& channelId) {
    if (client_ == nullptr || lobbyId.empty() || channelId.empty()) {
        return false;
    }

    client_->LinkChannelToLobby(
        std::strtoull(lobbyId.c_str(), nullptr, 10),
        std::strtoull(channelId.c_str(), nullptr, 10),
        [](discordpp::ClientResult linkResult) {
            if (!linkResult.Successful()) {
                std::cerr << "[DiscordBridge] LinkChannelToLobby failed: " << linkResult.ToString() << std::endl;
                return;
            }

            std::cerr << "[DiscordBridge] Channel linked to lobby successfully." << std::endl;
        }
    );

    return true;
}

bool DiscordBridge::sendToLobby(const ChatMessage& message) {
    if (!lobbyReady_.load() || client_ == nullptr || lobbyId_ == 0) {
        return false;
    }

    std::unordered_map<std::string, std::string> metadata;
        metadata.emplace("character_name", message.username);

    client_->SendLobbyMessageWithMetadata(
        lobbyId_,
        message.message,
        metadata,
        [](discordpp::ClientResult result, std::uint64_t) {
            if (!result.Successful()) {
                std::cerr << "[DiscordBridge] SendLobbyMessage failed: " << result.ToString() << std::endl;
            }
        }
    );

    return true;
}

void DiscordBridge::tick() {
    if (!initialized_.load()) {
        return;
    }

    discordpp::RunCallbacks();
}

void DiscordBridge::setOnDiscordMessage(DiscordMessageCallback cb) {
    onDiscordMessage_ = std::move(cb);
}

void DiscordBridge::bindDiscordEvents() {
    if (client_ == nullptr) {
        return;
    }

    client_->SetStatusChangedCallback(
        [this](discordpp::Client::Status status, discordpp::Client::Error error, int32_t errorDetail) {
            if (status == discordpp::Client::Status::Ready) {
                clientReady_.store(true);
                const bool joined = joinOrCreateLobby();
                if (!joined) {
                    std::cerr << "[DiscordBridge] Ready, but lobby join/create could not start yet." << std::endl;
                }
                return;
            }

            if (status == discordpp::Client::Status::Disconnected) {
                clientReady_.store(false);
                lobbyReady_.store(false);
                lobbyId_ = 0;
                std::cerr << "[DiscordBridge] Client disconnected. error=" << static_cast<int>(error)
                          << " detail=" << errorDetail << std::endl;
            }
        }
    );

    client_->SetTokenExpirationCallback([this]() {
        if (refreshToken_.empty() || client_ == nullptr) {
            return;
        }

        client_->RefreshToken(
            std::strtoull(config_.appId.c_str(), nullptr, 10),
            refreshToken_,
            [this](
                discordpp::ClientResult result,
                std::string accessToken,
                std::string refreshToken,
                discordpp::AuthorizationTokenType tokenType,
                int32_t,
                std::string
            ) {
                if (!result.Successful()) {
                    std::cerr << "[DiscordBridge] Token refresh on expiration failed: " << result.ToString() << std::endl;
                    clearCachedTokens();
                    return;
                }

                accessToken_ = std::move(accessToken);
                refreshToken_ = std::move(refreshToken);
                persistTokens();
                connectWithToken(tokenType, accessToken_);
            }
        );
    });

    client_->SetMessageCreatedCallback(
        [this](std::uint64_t messageId) {
            if (client_ == nullptr) {
                return;
            }

            const auto messageHandle = client_->GetMessageHandle(messageId);
            if (!messageHandle) {
                return;
            }

            handleIncomingDiscordMessage(*messageHandle);
        }
    );
}

void DiscordBridge::handleIncomingDiscordMessage(const discordpp::MessageHandle& message) {
    if (!onDiscordMessage_) {
        return;
    }

    if (message.SentFromGame()) {
        return;
    }

    if (message.Lobby()) {
        const auto lobby = message.Lobby();
        if (lobby && lobby->Id() != lobbyId_) {
            return;
        }
    }

    std::string username;
    if (const auto author = message.Author()) {
        username = resolveUserName(*author);
    }

    if (username.empty() && client_ != nullptr && message.AuthorId() != 0) {
        const auto author = client_->GetUser(message.AuthorId());
        if (author) {
            username = resolveUserName(*author);
        }
    }

    const auto metadata = message.Metadata();
    const auto metadataName = metadata.find("character_name");
    if (metadataName != metadata.end() && !metadataName->second.empty()) {
        username = metadataName->second;
    }

    if (username.empty() && message.AuthorId() != 0) {
        username = "DiscordUser#" + std::to_string(message.AuthorId());
    }

    if (username.empty()) {
        username = "Discord";
    }

    ChatMessage normalized {
        .playerId = 0,
        .username = username,
        .message = message.Content(),
    };

    onDiscordMessage_(normalized);
}

void DiscordBridge::startCallbackPump() {
    if (callbackPumpRunning_.exchange(true)) {
        return;
    }

    callbackPumpThread_ = std::thread([this]() {
        while (callbackPumpRunning_.load()) {
            tick();
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    });
}

void DiscordBridge::stopCallbackPump() {
    if (!callbackPumpRunning_.exchange(false)) {
        return;
    }

    if (callbackPumpThread_.joinable()) {
        callbackPumpThread_.join();
    }
}

std::string DiscordBridge::buildLobbySecret() const {
    if (!config_.lobbySecret.empty()) {
        return config_.lobbySecret;
    }

    return "dungeon-blitz-public-" + config_.linkedChannelId;
}

void DiscordBridge::connectWithToken(discordpp::AuthorizationTokenType tokenType, const std::string& accessToken) {
    if (client_ == nullptr) {
        return;
    }

    client_->UpdateToken(
        tokenType,
        accessToken,
        [this](discordpp::ClientResult updateResult) {
            if (!updateResult.Successful()) {
                std::cerr << "[DiscordBridge] UpdateToken failed: " << updateResult.ToString() << std::endl;
                clearCachedTokens();
                return;
            }

            client_->Connect();
        }
    );
}

bool DiscordBridge::loadCachedTokens() {
    if (config_.tokenCachePath.empty()) {
        std::cerr << "[DiscordBridge] Token cache path is empty." << std::endl;
        return false;
    }

    std::ifstream in(config_.tokenCachePath);
    if (!in.is_open()) {
        std::cerr << "[DiscordBridge] No token cache file at: " << config_.tokenCachePath << std::endl;
        return false;
    }

    const std::string contents((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    accessToken_ = extractJsonField(contents, "access_token").value_or("");
    refreshToken_ = extractJsonField(contents, "refresh_token").value_or("");
    std::cerr << "[DiscordBridge] Loaded token cache from: " << config_.tokenCachePath
              << " access=" << (!accessToken_.empty() ? "yes" : "no")
              << " refresh=" << (!refreshToken_.empty() ? "yes" : "no") << std::endl;
    return !accessToken_.empty() || !refreshToken_.empty();
}

void DiscordBridge::persistTokens() const {
    if (config_.tokenCachePath.empty()) {
        return;
    }

    std::ofstream out(config_.tokenCachePath, std::ios::trunc);
    if (!out.is_open()) {
        std::cerr << "[DiscordBridge] Failed to open token cache for writing: " << config_.tokenCachePath << std::endl;
        return;
    }

    out << "{"
        << "\"access_token\":\"" << jsonEscape(accessToken_) << "\","
        << "\"refresh_token\":\"" << jsonEscape(refreshToken_) << "\""
        << "}";
    std::cerr << "[DiscordBridge] Saved token cache to: " << config_.tokenCachePath << std::endl;
}

void DiscordBridge::clearCachedTokens() const {
    if (config_.tokenCachePath.empty()) {
        return;
    }

    if (std::remove(config_.tokenCachePath.c_str()) == 0) {
        std::cerr << "[DiscordBridge] Cleared token cache: " << config_.tokenCachePath << std::endl;
    }
}

} // namespace dungeon_blitz::bridge
