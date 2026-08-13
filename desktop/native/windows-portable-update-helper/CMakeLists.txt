cmake_minimum_required(VERSION 3.20)
project(windows_portable_update_helper LANGUAGES CXX)

add_executable(windows-portable-update-helper WIN32 main.cpp)
target_compile_features(windows-portable-update-helper PRIVATE cxx_std_20)
target_compile_definitions(windows-portable-update-helper PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(windows-portable-update-helper PRIVATE bcrypt crypt32 shell32)

if(MSVC)
    target_compile_options(windows-portable-update-helper PRIVATE /W4 /WX /permissive- /EHsc /utf-8)
    target_link_options(windows-portable-update-helper PRIVATE /INCREMENTAL:NO)
    set_property(TARGET windows-portable-update-helper PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

install(TARGETS windows-portable-update-helper RUNTIME DESTINATION .)
