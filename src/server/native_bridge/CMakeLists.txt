cmake_minimum_required(VERSION 3.20)
project(discord_social_bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
foreach(CONFIG_TYPE Debug Release RelWithDebInfo MinSizeRel)
    string(TOUPPER "${CONFIG_TYPE}" CONFIG_TYPE_UPPER)
    set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_${CONFIG_TYPE_UPPER} "${CMAKE_BINARY_DIR}")
endforeach()

set(DISCORD_SDK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/discord_social_sdk" CACHE PATH "Path to Discord Social SDK files")

add_executable(discord_social_bridge
    BridgeMain.cpp
    DiscordBridge.cpp
)

target_include_directories(discord_social_bridge PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${DISCORD_SDK_DIR}"
)

if(EXISTS "${DISCORD_SDK_DIR}/lib/release/libdiscord_partner_sdk.dylib")
    target_link_libraries(discord_social_bridge PRIVATE "${DISCORD_SDK_DIR}/lib/release/libdiscord_partner_sdk.dylib")
    add_custom_command(TARGET discord_social_bridge POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${DISCORD_SDK_DIR}/lib/release/libdiscord_partner_sdk.dylib"
            "$<TARGET_FILE_DIR:discord_social_bridge>/libdiscord_partner_sdk.dylib"
    )
elseif(WIN32)
    set(DISCORD_SDK_WIN_LIB "${DISCORD_SDK_DIR}/lib/release/discord_partner_sdk.lib")
    set(DISCORD_SDK_WIN_DLL "${DISCORD_SDK_DIR}/bin/release/discord_partner_sdk.dll")

    if(MSVC_CXX_ARCHITECTURE_ID STREQUAL "ARM64"
        AND EXISTS "${DISCORD_SDK_DIR}/lib/release/arm64/discord_partner_sdk.lib"
        AND EXISTS "${DISCORD_SDK_DIR}/bin/release/arm64/discord_partner_sdk.dll")
        set(DISCORD_SDK_WIN_LIB "${DISCORD_SDK_DIR}/lib/release/arm64/discord_partner_sdk.lib")
        set(DISCORD_SDK_WIN_DLL "${DISCORD_SDK_DIR}/bin/release/arm64/discord_partner_sdk.dll")
    endif()

    target_link_libraries(discord_social_bridge PRIVATE "${DISCORD_SDK_WIN_LIB}")
    add_custom_command(TARGET discord_social_bridge POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${DISCORD_SDK_WIN_DLL}"
            "$<TARGET_FILE_DIR:discord_social_bridge>/discord_partner_sdk.dll"
    )
endif()
