#include "DiscordBridge.hpp"

#define DISCORDPP_IMPLEMENTATION
#include "discord_social_sdk/include/discordpp.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <unordered_map>
#include <vector>

namespace dungeon_blitz::bridge {
namespace {

constexpr int CHANNEL_ALREADY_LINKED_ERROR_CODE = 50237;

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

ChannelLinkError captureChannelLinkError(const discordpp::ClientResult& result) {
    ChannelLinkError error {};
    error.errorCode = result.ErrorCode();
    error.httpStatus = static_cast<int>(result.Status());
    error.error = result.Error();
    error.responseBody = result.ResponseBody();
    error.summary = result.ToString();
    return error;
}

std::string channelLinkErrorJsonFields(const ChannelLinkError& error) {
    std::ostringstream out;
    out << "\"errorCode\":" << error.errorCode
        << ",\"httpStatus\":" << error.httpStatus
        << ",\"error\":\"" << jsonEscape(error.error) << "\""
        << ",\"responseBody\":\"" << jsonEscape(error.responseBody) << "\""
        << ",\"summary\":\"" << jsonEscape(error.summary) << "\"";
    return out.str();
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
    if (config_.gameWindowPid > 0) {
        client_->SetGameWindowPid(config_.gameWindowPid);
        std::cerr << "[DiscordBridge] Using game window pid for Discord overlay: " << config_.gameWindowPid << std::endl;
    }
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
                    beginAuthorizationAfterTokenFailure();
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

    if (!accessToken_.empty()) {
        connectWithToken(discordpp::AuthorizationTokenType::Bearer, accessToken_);
        return true;
    }

    return false;
}

std::optional<DeviceAuthorizationInfo> DiscordBridge::beginDeviceAuthorization() {
    if (!initialized_.load() || client_ == nullptr || authInFlight_.exchange(true)) {
        return std::nullopt;
    }

    if (!config_.useDeviceFlow) {
        auto verifier = client_->CreateAuthorizationCodeVerifier();
        pkceVerifier_ = verifier.Verifier();

        discordpp::AuthorizationArgs args {};
        args.SetClientId(std::strtoull(config_.appId.c_str(), nullptr, 10));
        args.SetScopes(discordpp::Client::GetDefaultCommunicationScopes());
        args.SetCodeChallenge(verifier.Challenge());

        client_->Authorize(
            args,
            [this](discordpp::ClientResult result, std::string code, std::string redirectUri) {
                if (!result.Successful()) {
                    authInFlight_.store(false);
                    std::cerr << "[DiscordBridge] Authorize failed: " << result.ToString() << std::endl;
                    return;
                }

                client_->GetToken(
                    std::strtoull(config_.appId.c_str(), nullptr, 10),
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
    }

    discordpp::DeviceAuthorizationArgs args {};
    args.SetClientId(std::strtoull(config_.appId.c_str(), nullptr, 10));
    args.SetScopes(discordpp::Client::GetDefaultCommunicationScopes());

    client_->GetTokenFromDevice(
        args,
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
        }
    );

    return std::nullopt;
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
                    std::string linkedChannelId;
                    bool alreadyLinked = false;
                    const auto lobby = client_->GetLobbyHandle(lobbyId);
                    if (lobby) {
                        const auto linkedChannel = lobby->LinkedChannel();
                        if (linkedChannel) {
                            linkedChannelId = std::to_string(linkedChannel->Id());
                            alreadyLinked = linkedChannelId == config_.linkedChannelId;
                        }
                    }

                    std::cout << "{\"type\":\"lobby_ready\",\"lobbyId\":\"" << lobbyId_
                              << "\",\"userId\":\"" << currentUser->Id()
                              << "\",\"alreadyLinked\":" << (alreadyLinked ? "true" : "false")
                              << ",\"linkedChannelId\":\"" << jsonEscape(linkedChannelId) << "\"}" << std::endl;
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
        [this, lobbyId, channelId](discordpp::ClientResult linkResult) {
            if (!linkResult.Successful()) {
                std::cerr << "[DiscordBridge] LinkChannelToLobby failed: " << linkResult.ToString() << std::endl;
                const auto error = captureChannelLinkError(linkResult);
                if (error.errorCode == CHANNEL_ALREADY_LINKED_ERROR_CODE) {
                    inspectLinkedChannelConflict(lobbyId, channelId, error);
                    return;
                }

                emitChannelLinkFailed(lobbyId, channelId, error);
                return;
            }

            std::cerr << "[DiscordBridge] Channel linked to lobby successfully." << std::endl;
            emitChannelLinked(lobbyId, channelId, false);
        }
    );

    return true;
}

bool DiscordBridge::useLobby(const std::string& lobbyId, const std::string& channelId) {
    const auto parsedLobbyId = std::strtoull(lobbyId.c_str(), nullptr, 10);
    if (client_ == nullptr || parsedLobbyId == 0) {
        return false;
    }

    pendingLinkedLobbyId_ = parsedLobbyId;
    pendingLinkedChannelId_ = channelId;
    (void)tryUseLoadedLobby(parsedLobbyId, channelId, true);
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
        [](discordpp::ClientResult result, std::uint64_t messageId) {
            if (!result.Successful()) {
                std::cerr << "[DiscordBridge] SendLobbyMessage failed: " << result.ToString() << std::endl;
            }
            std::cout << "{\"type\":\"send_result\",\"ok\":" << (result.Successful() ? "true" : "false")
                      << ",\"messageId\":\"" << messageId << "\",\"error\":\""
                      << (result.Successful() ? "" : jsonEscape(result.ToString())) << "\"}" << std::endl;
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
                pendingLinkedLobbyId_ = 0;
                pendingLinkedChannelId_.clear();
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
                    beginAuthorizationAfterTokenFailure();
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

    const auto tryPendingLinkedLobby = [this](std::uint64_t lobbyId) {
        if (pendingLinkedLobbyId_ == 0 || pendingLinkedLobbyId_ != lobbyId) {
            return;
        }

        (void)tryUseLoadedLobby(lobbyId, pendingLinkedChannelId_, false);
    };

    client_->SetLobbyCreatedCallback(tryPendingLinkedLobby);
    client_->SetLobbyUpdatedCallback(tryPendingLinkedLobby);
    client_->SetLobbyMemberAddedCallback(
        [tryPendingLinkedLobby](std::uint64_t lobbyId, std::uint64_t) {
            tryPendingLinkedLobby(lobbyId);
        }
    );
    client_->SetLobbyMemberUpdatedCallback(
        [tryPendingLinkedLobby](std::uint64_t lobbyId, std::uint64_t) {
            tryPendingLinkedLobby(lobbyId);
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

void DiscordBridge::inspectLinkedChannelConflict(
    const std::string& lobbyId,
    const std::string& channelId,
    ChannelLinkError error
) {
    if (client_ == nullptr) {
        emitChannelLinkFailed(lobbyId, channelId, error);
        return;
    }

    const auto targetChannelId = std::strtoull(channelId.c_str(), nullptr, 10);
    if (targetChannelId == 0) {
        emitChannelLinkFailed(lobbyId, channelId, error);
        return;
    }

    struct LookupState {
        std::size_t pendingGuilds { 0 };
        bool completed { false };
        std::uint64_t targetChannelId { 0 };
        std::string lobbyId;
        std::string channelId;
        ChannelLinkError error;
    };

    client_->GetUserGuilds(
        [this, lobbyId, channelId, targetChannelId, error](discordpp::ClientResult result, std::vector<discordpp::GuildMinimal> guilds) {
            if (!result.Successful() || guilds.empty() || client_ == nullptr) {
                emitChannelLinkFailed(lobbyId, channelId, error);
                return;
            }

            auto state = std::make_shared<LookupState>();
            state->pendingGuilds = guilds.size();
            state->targetChannelId = targetChannelId;
            state->lobbyId = lobbyId;
            state->channelId = channelId;
            state->error = error;

            for (const auto& guild : guilds) {
                client_->GetGuildChannels(
                    guild.Id(),
                    [this, state](discordpp::ClientResult channelResult, std::vector<discordpp::GuildChannel> channels) {
                        if (state->completed) {
                            return;
                        }

                        if (channelResult.Successful()) {
                            for (const auto& channel : channels) {
                                if (channel.Id() != state->targetChannelId) {
                                    continue;
                                }

                                const auto linkedLobby = channel.LinkedLobby();
                                if (!linkedLobby) {
                                    state->completed = true;
                                    emitChannelLinkFailed(state->lobbyId, state->channelId, state->error);
                                    return;
                                }

                                state->completed = true;
                                const auto existingLobbyId = linkedLobby->LobbyId();
                                const auto existingApplicationId = linkedLobby->ApplicationId();
                                const auto requestedLobbyId = std::strtoull(state->lobbyId.c_str(), nullptr, 10);
                                const auto currentApplicationId = std::strtoull(config_.appId.c_str(), nullptr, 10);

                                if (existingLobbyId == requestedLobbyId) {
                                    emitChannelLinked(state->lobbyId, state->channelId, false);
                                    return;
                                }

                                if (existingApplicationId == currentApplicationId &&
                                    tryUseLoadedLobby(existingLobbyId, state->channelId, false)) {
                                    return;
                                }

                                emitChannelLinkConflict(
                                    state->lobbyId,
                                    state->channelId,
                                    existingLobbyId,
                                    existingApplicationId,
                                    state->error
                                );
                                return;
                            }
                        }

                        if (state->pendingGuilds > 0) {
                            --state->pendingGuilds;
                        }

                        if (state->pendingGuilds == 0 && !state->completed) {
                            state->completed = true;
                            emitChannelLinkFailed(state->lobbyId, state->channelId, state->error);
                        }
                    }
                );
            }
        }
    );
}

void DiscordBridge::emitChannelLinked(const std::string& lobbyId, const std::string& channelId, bool reusedExisting) const {
    std::cout << "{\"type\":\"channel_linked\",\"lobbyId\":\"" << jsonEscape(lobbyId)
              << "\",\"channelId\":\"" << jsonEscape(channelId)
              << "\",\"reusedExisting\":" << (reusedExisting ? "true" : "false") << "}" << std::endl;
}

void DiscordBridge::emitChannelLinkFailed(
    const std::string& lobbyId,
    const std::string& channelId,
    const ChannelLinkError& error
) const {
    std::cout << "{\"type\":\"channel_link_failed\",\"lobbyId\":\"" << jsonEscape(lobbyId)
              << "\",\"channelId\":\"" << jsonEscape(channelId) << "\","
              << channelLinkErrorJsonFields(error) << "}" << std::endl;
}

void DiscordBridge::emitChannelLinkConflict(
    const std::string& lobbyId,
    const std::string& channelId,
    std::uint64_t existingLobbyId,
    std::uint64_t existingApplicationId,
    const ChannelLinkError& error
) const {
    std::cout << "{\"type\":\"channel_link_conflict\",\"lobbyId\":\"" << jsonEscape(lobbyId)
              << "\",\"channelId\":\"" << jsonEscape(channelId)
              << "\",\"existingLobbyId\":\"" << existingLobbyId
              << "\",\"existingApplicationId\":\"" << existingApplicationId << "\","
              << channelLinkErrorJsonFields(error) << "}" << std::endl;
}

bool DiscordBridge::tryUseLoadedLobby(std::uint64_t lobbyId, const std::string& channelId, bool emitWaitingStatus) {
    if (client_ == nullptr || lobbyId == 0) {
        return false;
    }

    const auto lobby = client_->GetLobbyHandle(lobbyId);
    if (!lobby) {
        if (emitWaitingStatus) {
            std::cout << "{\"type\":\"status\",\"text\":\"Waiting for Discord SDK to load existing linked lobby "
                      << lobbyId << ".\"}" << std::endl;
        }
        return false;
    }

    lobbyId_ = lobbyId;
    lobbyReady_.store(true);
    pendingLinkedLobbyId_ = 0;
    pendingLinkedChannelId_.clear();
    std::cerr << "[DiscordBridge] Reusing existing linked Discord lobby " << lobbyId << "." << std::endl;
    emitChannelLinked(std::to_string(lobbyId), channelId, true);
    return true;
}

void DiscordBridge::beginAuthorizationAfterTokenFailure() {
    const auto auth = beginDeviceAuthorization();
    if (auth) {
        std::cout << "{\"type\":\"auth\",\"verificationUri\":\"" << jsonEscape(auth->verificationUri)
                  << "\",\"userCode\":\"" << jsonEscape(auth->userCode) << "\"}" << std::endl;
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
                beginAuthorizationAfterTokenFailure();
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

void DiscordBridge::clearCachedTokens() {
    accessToken_.clear();
    refreshToken_.clear();

    if (config_.tokenCachePath.empty()) {
        return;
    }

    if (std::remove(config_.tokenCachePath.c_str()) == 0) {
        std::cerr << "[DiscordBridge] Cleared token cache: " << config_.tokenCachePath << std::endl;
    }
}

} // namespace dungeon_blitz::bridge
