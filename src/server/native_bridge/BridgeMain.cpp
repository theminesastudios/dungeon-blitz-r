#include "DiscordBridge.hpp"

#include <cctype>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>

namespace {

std::string trim(const std::string& value) {
    std::size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start])) != 0) {
        ++start;
    }

    std::size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1])) != 0) {
        --end;
    }

    return value.substr(start, end - start);
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

void emitJson(const std::string& payload) {
    std::cout << payload << std::endl;
}

std::optional<std::string> extractJsonString(const std::string& json, const std::string& key) {
    const auto keyToken = "\"" + key + "\"";
    const auto keyPos = json.find(keyToken);
    if (keyPos == std::string::npos) {
        return std::nullopt;
    }

    const auto colonPos = json.find(':', keyPos + keyToken.size());
    if (colonPos == std::string::npos) {
        return std::nullopt;
    }

    const auto firstQuote = json.find('"', colonPos + 1);
    if (firstQuote == std::string::npos) {
        return std::nullopt;
    }

    std::string value;
    bool escaped = false;
    for (std::size_t i = firstQuote + 1; i < json.size(); ++i) {
        const char ch = json[i];
        if (escaped) {
            switch (ch) {
                case 'n':
                    value.push_back('\n');
                    break;
                case 'r':
                    value.push_back('\r');
                    break;
                case 't':
                    value.push_back('\t');
                    break;
                default:
                    value.push_back(ch);
                    break;
            }
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

std::string jsonNumberString(std::uint64_t value) {
    return std::to_string(value);
}

bool extractJsonBool(const std::string& json, const std::string& key, bool fallback) {
    const auto keyToken = "\"" + key + "\"";
    const auto keyPos = json.find(keyToken);
    if (keyPos == std::string::npos) {
        return fallback;
    }

    const auto colonPos = json.find(':', keyPos + keyToken.size());
    if (colonPos == std::string::npos) {
        return fallback;
    }

    const auto remainder = trim(json.substr(colonPos + 1));
    if (remainder.rfind("true", 0) == 0) {
        return true;
    }

    if (remainder.rfind("false", 0) == 0) {
        return false;
    }

    return fallback;
}

int extractJsonInt(const std::string& json, const std::string& key, int fallback) {
    const auto keyToken = "\"" + key + "\"";
    const auto keyPos = json.find(keyToken);
    if (keyPos == std::string::npos) {
        return fallback;
    }

    const auto colonPos = json.find(':', keyPos + keyToken.size());
    if (colonPos == std::string::npos) {
        return fallback;
    }

    const auto remainder = trim(json.substr(colonPos + 1));
    if (remainder.empty()) {
        return fallback;
    }

    try {
        std::size_t parsedLength = 0;
        const auto parsed = std::stoi(remainder, &parsedLength, 10);
        return parsedLength > 0 ? parsed : fallback;
    } catch (...) {
        return fallback;
    }
}

} // namespace

int main() {
    dungeon_blitz::bridge::DiscordBridge bridge;

    bridge.setOnDiscordMessage([](const dungeon_blitz::bridge::ChatMessage& message) {
        emitJson(
            "{\"type\":\"chat\",\"username\":\"" + jsonEscape(message.username) +
            "\",\"authorId\":\"" + jsonNumberString(message.playerId) +
            "\",\"channelId\":\"" + jsonNumberString(message.channelId) +
            "\",\"messageId\":\"" + jsonNumberString(message.messageId) +
            "\",\"sentTimestamp\":\"" + jsonNumberString(message.sentTimestamp) +
            "\",\"message\":\"" + jsonEscape(message.message) +
            "\",\"rawMessage\":\"" + jsonEscape(message.rawMessage) + "\"}"
        );
    });

    std::string line;
    while (std::getline(std::cin, line)) {
        const auto trimmed = trim(line);
        if (trimmed.empty()) {
            continue;
        }

        const auto type = extractJsonString(trimmed, "type");
        if (!type) {
            emitJson("{\"type\":\"status\",\"text\":\"Native bridge received malformed message.\"}");
            continue;
        }

        if (*type == "initialize") {
            dungeon_blitz::bridge::DiscordBridgeConfig config {};
            config.appId = extractJsonString(trimmed, "appId").value_or("");
            config.lobbySecret = extractJsonString(trimmed, "lobbySecret").value_or("");
            config.linkedChannelId = extractJsonString(trimmed, "channelId").value_or("");
            config.tokenCachePath = extractJsonString(trimmed, "tokenCachePath").value_or("");
            config.gameWindowPid = extractJsonInt(trimmed, "gameWindowPid", 0);
            config.useDeviceFlow = extractJsonBool(trimmed, "deviceFlow", false);
            config.enableChannelLinking = extractJsonBool(trimmed, "enableChannelLinking", false);

            if (!bridge.initialize(config)) {
                emitJson("{\"type\":\"status\",\"text\":\"Discord Social SDK bridge initialize failed.\"}");
                continue;
            }

            emitJson("{\"type\":\"ready\"}");
            if (!bridge.tryRestoreSession()) {
                const auto auth = bridge.beginDeviceAuthorization();
                if (auth) {
                    emitJson(
                        "{\"type\":\"auth\",\"verificationUri\":\"" + jsonEscape(auth->verificationUri) +
                        "\",\"userCode\":\"" + jsonEscape(auth->userCode) + "\"}"
                    );
                }
            }

            if (!bridge.joinOrCreateLobby()) {
                emitJson("{\"type\":\"status\",\"text\":\"Discord lobby join/create is not completed yet.\"}");
            }

            continue;
        }

        if (*type == "outbound_chat") {
            dungeon_blitz::bridge::ChatMessage message {};
            message.username = extractJsonString(trimmed, "senderName").value_or("");
            message.message = extractJsonString(trimmed, "message").value_or("");

            if (!bridge.sendToLobby(message)) {
                emitJson("{\"type\":\"status\",\"text\":\"Discord Social SDK lobby send is not available yet.\"}");
            }

            continue;
        }

        if (*type == "use_lobby") {
            const auto lobbyId = extractJsonString(trimmed, "lobbyId").value_or("");
            const auto channelId = extractJsonString(trimmed, "channelId").value_or("");
            if (!bridge.useLobby(lobbyId, channelId)) {
                emitJson("{\"type\":\"status\",\"text\":\"Existing Discord linked lobby is not loaded yet.\"}");
            }
            continue;
        }

        if (*type == "link_channel") {
            const auto lobbyId = extractJsonString(trimmed, "lobbyId").value_or("");
            const auto channelId = extractJsonString(trimmed, "channelId").value_or("");
            if (!bridge.linkChannelToLobby(lobbyId, channelId)) {
                emitJson("{\"type\":\"status\",\"text\":\"LinkChannelToLobby could not start.\"}");
            }
            continue;
        }

        emitJson("{\"type\":\"status\",\"text\":\"Unsupported native bridge command.\"}");
    }

    return 0;
}
