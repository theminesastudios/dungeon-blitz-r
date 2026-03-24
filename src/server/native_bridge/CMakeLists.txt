cmake_minimum_required(VERSION 3.20)
project(discord_social_bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(DISCORD_SDK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/discord_social_sdk" CACHE PATH "Path to Discord Social SDK files")

add_executable(discord_social_bridge
    BridgeMain.cpp
    DiscordBridge.cpp
)

set_target_properties(discord_social_bridge PROPERTIES
    BUILD_RPATH "@executable_path"
    INSTALL_RPATH "@executable_path"
)

target_include_directories(discord_social_bridge PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${DISCORD_SDK_DIR}"
)

if(EXISTS "${DISCORD_SDK_DIR}/lib/release/libdiscord_partner_sdk.dylib")
    target_link_libraries(discord_social_bridge PRIVATE "${DISCORD_SDK_DIR}/lib/release/libdiscord_partner_sdk.dylib")
elseif(EXISTS "${DISCORD_SDK_DIR}/discord_partner_sdk.dll.lib")
    target_link_libraries(discord_social_bridge PRIVATE "${DISCORD_SDK_DIR}/discord_partner_sdk.dll.lib")
endif()
