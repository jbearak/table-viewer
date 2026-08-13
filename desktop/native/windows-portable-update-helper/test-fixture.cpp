#include <windows.h>
#include <shellapi.h>

#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>

namespace {
constexpr std::wstring_view kChildArgument = L"--fixture-child=";

[[maybe_unused]] std::wstring quote_argument(std::wstring_view value) {
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (wchar_t ch : value) {
        if (ch == L'\\') { ++slashes; continue; }
        if (ch == L'\"') {
            result.append(slashes * 2 + 1, L'\\');
            result.push_back(L'\"');
            slashes = 0;
            continue;
        }
        result.append(slashes, L'\\');
        slashes = 0;
        result.push_back(ch);
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}

void write_marker(const std::filesystem::path& path, std::string_view value) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output << value;
}
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    int argc = 0;
    wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return 2;

    std::filesystem::path marker;
    for (int index = 1; index < argc; ++index) {
        const std::wstring_view argument(argv[index]);
        if (argument.starts_with(kChildArgument)) {
            marker = std::wstring(argument.substr(kChildArgument.size()));
        }
    }

#ifdef PORTABLE_UPDATE_FIXTURE_OLD
    const auto executable = std::filesystem::path(argv[0]);
    std::ofstream marker_output(executable.parent_path() / L"old-relaunched", std::ios::binary | std::ios::app);
    marker_output << "old-relaunched\n";
    LocalFree(argv);
    return 0;
#else
    if (!marker.empty()) {
        write_marker(marker, "inner-running");
        Sleep(INFINITE);
    }

    const auto executable = std::filesystem::path(argv[0]);
    const auto inner_marker = executable.parent_path() / L"inner-running";
    std::wstring command = quote_argument(executable.wstring()) + L" " +
                           quote_argument(std::wstring(kChildArgument) + inner_marker.wstring());
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
                        CREATE_UNICODE_ENVIRONMENT, nullptr, executable.parent_path().c_str(),
                        &startup, &child)) {
        LocalFree(argv);
        return 3;
    }
    CloseHandle(child.hThread);
    WaitForSingleObject(child.hProcess, INFINITE);
    CloseHandle(child.hProcess);
    LocalFree(argv);
    return 0;
#endif
}
