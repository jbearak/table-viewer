#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <wincrypt.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <limits>
#include <map>
#include <optional>
#include <system_error>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace {
constexpr DWORD kAckTimeoutMs = 30'000;
constexpr DWORD kPollIntervalMs = 100;
constexpr std::uintmax_t kMaxTransactionBytes = 64 * 1024;
constexpr wchar_t kAckPrefix[] = L"--portable-update-ack=";

struct Transaction {
    std::string transaction_id;
    std::string version;
    std::filesystem::path target_path;
    std::filesystem::path replacement_path;
    std::filesystem::path backup_path;
    std::string expected_target_sha512;
    std::string expected_replacement_sha512;
    std::uint64_t expected_replacement_size = 0;
    DWORD wrapper_pid = 0;
    std::filesystem::path acknowledgement_path;
    std::string acknowledgement_token;
    std::filesystem::path result_path;
};

struct JsonValue {
    enum class Type { string, number } type;
    std::string string_value;
    std::uint64_t number_value = 0;
};

class JsonParser {
public:
    explicit JsonParser(std::string_view input) : input_(input) {}

    std::optional<std::map<std::string, JsonValue>> parse_object() {
        skip_space();
        if (!take('{')) return std::nullopt;
        std::map<std::string, JsonValue> result;
        skip_space();
        if (take('}')) return result;
        for (;;) {
            auto key = parse_string();
            if (!key || !result.emplace(*key, JsonValue{}).second) return std::nullopt;
            skip_space();
            if (!take(':')) return std::nullopt;
            skip_space();
            JsonValue value;
            if (peek() == '"') {
                auto text = parse_string();
                if (!text) return std::nullopt;
                value.type = JsonValue::Type::string;
                value.string_value = std::move(*text);
            } else {
                auto number = parse_number();
                if (!number) return std::nullopt;
                value.type = JsonValue::Type::number;
                value.number_value = *number;
            }
            result[*key] = std::move(value);
            skip_space();
            if (take('}')) break;
            if (!take(',')) return std::nullopt;
            skip_space();
        }
        skip_space();
        return position_ == input_.size() ? std::optional(result) : std::nullopt;
    }

private:
    char peek() const { return position_ < input_.size() ? input_[position_] : '\0'; }
    bool take(char expected) {
        if (peek() != expected) return false;
        ++position_;
        return true;
    }
    void skip_space() {
        while (position_ < input_.size() &&
               (input_[position_] == ' ' || input_[position_] == '\t' ||
                input_[position_] == '\r' || input_[position_] == '\n')) ++position_;
    }
    std::optional<std::string> parse_string() {
        if (!take('"')) return std::nullopt;
        std::string result;
        while (position_ < input_.size()) {
            unsigned char ch = static_cast<unsigned char>(input_[position_++]);
            if (ch == '"') return result;
            if (ch < 0x20) return std::nullopt;
            if (ch != '\\') {
                result.push_back(static_cast<char>(ch));
                continue;
            }
            if (position_ == input_.size()) return std::nullopt;
            switch (input_[position_++]) {
            case '"': result.push_back('"'); break;
            case '\\': result.push_back('\\'); break;
            case '/': result.push_back('/'); break;
            case 'b': result.push_back('\b'); break;
            case 'f': result.push_back('\f'); break;
            case 'n': result.push_back('\n'); break;
            case 'r': result.push_back('\r'); break;
            case 't': result.push_back('\t'); break;
            case 'u': {
                if (position_ + 4 > input_.size()) return std::nullopt;
                unsigned value = 0;
                for (int index = 0; index < 4; ++index) {
                    const char digit = input_[position_++];
                    value <<= 4;
                    if (digit >= '0' && digit <= '9') value += digit - '0';
                    else if (digit >= 'a' && digit <= 'f') value += digit - 'a' + 10;
                    else if (digit >= 'A' && digit <= 'F') value += digit - 'A' + 10;
                    else return std::nullopt;
                }
                if (value >= 0xd800 && value <= 0xdfff) return std::nullopt;
                if (value <= 0x7f) result.push_back(static_cast<char>(value));
                else if (value <= 0x7ff) {
                    result.push_back(static_cast<char>(0xc0 | (value >> 6)));
                    result.push_back(static_cast<char>(0x80 | (value & 0x3f)));
                } else {
                    result.push_back(static_cast<char>(0xe0 | (value >> 12)));
                    result.push_back(static_cast<char>(0x80 | ((value >> 6) & 0x3f)));
                    result.push_back(static_cast<char>(0x80 | (value & 0x3f)));
                }
                break;
            }
            default: return std::nullopt;
            }
        }
        return std::nullopt;
    }
    std::optional<std::uint64_t> parse_number() {
        const std::size_t start = position_;
        if (peek() == '0') ++position_;
        else {
            if (peek() < '1' || peek() > '9') return std::nullopt;
            while (peek() >= '0' && peek() <= '9') ++position_;
        }
        std::uint64_t value = 0;
        const auto [end, error] = std::from_chars(input_.data() + start, input_.data() + position_, value);
        if (error != std::errc{} || end != input_.data() + position_) return std::nullopt;
        return value;
    }

    std::string_view input_;
    std::size_t position_ = 0;
};

std::string windows_error(DWORD error) {
    return "win32-" + std::to_string(error);
}

std::string json_escape(std::string_view value) {
    std::string result;
    for (const unsigned char ch : value) {
        switch (ch) {
        case '"': result += "\\\""; break;
        case '\\': result += "\\\\"; break;
        case '\b': result += "\\b"; break;
        case '\f': result += "\\f"; break;
        case '\n': result += "\\n"; break;
        case '\r': result += "\\r"; break;
        case '\t': result += "\\t"; break;
        default:
            if (ch < 0x20) {
                constexpr char hex[] = "0123456789abcdef";
                result += "\\u00";
                result.push_back(hex[ch >> 4]);
                result.push_back(hex[ch & 15]);
            } else result.push_back(static_cast<char>(ch));
        }
    }
    return result;
}

bool atomic_write(const std::filesystem::path& path, std::string_view contents) {
    const auto temporary = path.wstring() + L".tmp";
    {
        std::ofstream output(std::filesystem::path(temporary), std::ios::binary | std::ios::trunc);
        if (!output) return false;
        output.write(contents.data(), static_cast<std::streamsize>(contents.size()));
        output.flush();
        if (!output) return false;
    }
    if (MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return true;
    DeleteFileW(temporary.c_str());
    return false;
}

void write_result(const Transaction* transaction, std::string_view status, std::string_view error = {}) {
    if (!transaction || transaction->result_path.empty()) return;
    std::ostringstream json;
    json << "{\"schema_version\":1,\"transaction_id\":\""
         << json_escape(transaction->transaction_id) << "\",\"status\":\""
         << json_escape(status) << '"';
    if (!error.empty()) json << ",\"error\":\"" << json_escape(error) << '"';
    json << '}';
    atomic_write(transaction->result_path, json.str());
}

std::optional<std::wstring> utf8_to_wide(std::string_view input) {
    if (input.empty()) return std::wstring{};
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                                         static_cast<int>(input.size()), nullptr, 0);
    if (size <= 0) return std::nullopt;
    std::wstring output(static_cast<std::size_t>(size), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                            static_cast<int>(input.size()), output.data(), size) != size) return std::nullopt;
    return output;
}

bool is_hex_token(std::string_view value) {
    return value.size() == 32 && std::all_of(value.begin(), value.end(), [](char ch) {
        return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
    });
}

std::optional<Transaction> parse_transaction(const std::filesystem::path& path) {
    std::error_code ec;
    const auto size = std::filesystem::file_size(path, ec);
    if (ec || size == 0 || size > kMaxTransactionBytes) return std::nullopt;
    std::ifstream input(path, std::ios::binary);
    std::string document((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    auto object = JsonParser(document).parse_object();
    if (!object) return std::nullopt;

    auto number = [&](std::string_view key) -> std::optional<std::uint64_t> {
        const auto found = object->find(std::string(key));
        if (found == object->end() || found->second.type != JsonValue::Type::number) return std::nullopt;
        return found->second.number_value;
    };
    auto text = [&](std::string_view key) -> std::optional<std::string> {
        const auto found = object->find(std::string(key));
        if (found == object->end() || found->second.type != JsonValue::Type::string) return std::nullopt;
        return found->second.string_value;
    };
    if (object->size() != 13 || number("schema_version") != 1) return std::nullopt;

    Transaction transaction;
    auto transaction_id = text("transaction_id");
    auto version = text("version");
    auto target = text("target_path");
    auto replacement = text("replacement_path");
    auto backup = text("backup_path");
    auto target_hash = text("expected_target_sha512");
    auto replacement_hash = text("expected_replacement_sha512");
    auto replacement_size = number("expected_replacement_size");
    auto wrapper_pid = number("wrapper_pid");
    auto acknowledgement = text("acknowledgement_path");
    auto token = text("acknowledgement_token");
    auto result = text("result_path");
    if (!transaction_id || !version || !target || !replacement || !backup || !target_hash ||
        !replacement_hash || !replacement_size || !wrapper_pid || !acknowledgement || !token || !result ||
        !is_hex_token(*transaction_id) || !is_hex_token(*token) || *replacement_size == 0 ||
        *wrapper_pid == 0 || *wrapper_pid > std::numeric_limits<DWORD>::max()) return std::nullopt;

    auto target_w = utf8_to_wide(*target);
    auto replacement_w = utf8_to_wide(*replacement);
    auto backup_w = utf8_to_wide(*backup);
    auto acknowledgement_w = utf8_to_wide(*acknowledgement);
    auto result_w = utf8_to_wide(*result);
    if (!target_w || !replacement_w || !backup_w || !acknowledgement_w || !result_w) return std::nullopt;

    transaction.transaction_id = std::move(*transaction_id);
    transaction.version = std::move(*version);
    transaction.target_path = *target_w;
    transaction.replacement_path = *replacement_w;
    transaction.backup_path = *backup_w;
    transaction.expected_target_sha512 = std::move(*target_hash);
    transaction.expected_replacement_sha512 = std::move(*replacement_hash);
    transaction.expected_replacement_size = *replacement_size;
    transaction.wrapper_pid = static_cast<DWORD>(*wrapper_pid);
    transaction.acknowledgement_path = *acknowledgement_w;
    transaction.acknowledgement_token = std::move(*token);
    transaction.result_path = *result_w;

    const auto normalized = [](const std::filesystem::path& value) {
        return std::filesystem::weakly_canonical(value).wstring();
    };
    if (!transaction.target_path.is_absolute() || !transaction.replacement_path.is_absolute() ||
        !transaction.backup_path.is_absolute() || !transaction.acknowledgement_path.is_absolute() ||
        !transaction.result_path.is_absolute()) return std::nullopt;
    if (_wcsicmp(normalized(transaction.target_path).c_str(), normalized(transaction.replacement_path).c_str()) == 0 ||
        _wcsicmp(normalized(transaction.target_path).c_str(), normalized(transaction.backup_path).c_str()) == 0 ||
        _wcsicmp(normalized(transaction.replacement_path).c_str(), normalized(transaction.backup_path).c_str()) == 0) return std::nullopt;
    if (_wcsicmp(transaction.target_path.parent_path().c_str(), transaction.replacement_path.parent_path().c_str()) != 0 ||
        _wcsicmp(transaction.target_path.parent_path().c_str(), transaction.backup_path.parent_path().c_str()) != 0) return std::nullopt;
    return transaction;
}

std::optional<std::string> sha512_file(const std::filesystem::path& path) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD object_size = 0;
    DWORD bytes = 0;
    std::vector<UCHAR> object;
    std::array<UCHAR, 64> digest{};
    auto cleanup = [&] {
        if (hash) BCryptDestroyHash(hash);
        if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    };
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA512_ALGORITHM, nullptr, 0) < 0 ||
        BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_size),
                          sizeof(object_size), &bytes, 0) < 0) {
        cleanup(); return std::nullopt;
    }
    object.resize(object_size);
    if (BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) < 0) {
        cleanup(); return std::nullopt;
    }
    std::ifstream input(path, std::ios::binary);
    std::array<char, 1024 * 1024> buffer{};
    if (!input) { cleanup(); return std::nullopt; }
    while (input) {
        input.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
        const auto count = input.gcount();
        if (count > 0 && BCryptHashData(hash, reinterpret_cast<PUCHAR>(buffer.data()),
                                        static_cast<ULONG>(count), 0) < 0) {
            cleanup(); return std::nullopt;
        }
    }
    if (!input.eof() || BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
        cleanup(); return std::nullopt;
    }
    cleanup();
    DWORD encoded_size = 0;
    if (!CryptBinaryToStringA(digest.data(), static_cast<DWORD>(digest.size()),
                              CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &encoded_size)) return std::nullopt;
    std::string encoded(encoded_size, '\0');
    if (!CryptBinaryToStringA(digest.data(), static_cast<DWORD>(digest.size()),
                              CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, encoded.data(), &encoded_size)) return std::nullopt;
    if (!encoded.empty() && encoded.back() == '\0') encoded.pop_back();
    return encoded;
}

bool wait_for_wrapper(DWORD pid, std::string& error) {
    HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!process) {
        if (GetLastError() == ERROR_INVALID_PARAMETER) return true;
        error = windows_error(GetLastError());
        return false;
    }
    const DWORD wait = WaitForSingleObject(process, INFINITE);
    CloseHandle(process);
    if (wait == WAIT_OBJECT_0) return true;
    error = windows_error(GetLastError());
    return false;
}

std::wstring quote_argument(std::wstring_view value) {
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (wchar_t ch : value) {
        if (ch == L'\\') { ++slashes; continue; }
        if (ch == L'"') {
            result.append(slashes * 2 + 1, L'\\');
            result.push_back(L'"');
            slashes = 0;
            continue;
        }
        result.append(slashes, L'\\');
        slashes = 0;
        result.push_back(ch);
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'"');
    return result;
}

std::optional<PROCESS_INFORMATION> launch_replacement(const Transaction& transaction, std::string& error) {
    const auto token = utf8_to_wide(transaction.acknowledgement_token);
    if (!token) { error = "invalid-token"; return std::nullopt; }
    std::wstring command = quote_argument(transaction.target_path.wstring()) + L" " +
                           quote_argument(std::wstring(kAckPrefix) + *token);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(transaction.target_path.c_str(), command.data(), nullptr, nullptr, FALSE,
                        CREATE_UNICODE_ENVIRONMENT, nullptr, transaction.target_path.parent_path().c_str(),
                        &startup, &process)) {
        error = windows_error(GetLastError());
        return std::nullopt;
    }
    CloseHandle(process.hThread);
    return process;
}

bool acknowledgement_matches(const Transaction& transaction) {
    std::ifstream input(transaction.acknowledgement_path, std::ios::binary);
    if (!input) return false;
    std::string value((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    while (!value.empty() && (value.back() == '\r' || value.back() == '\n')) value.pop_back();
    return value == transaction.acknowledgement_token;
}

enum class AcknowledgementResult { acknowledged, child_exited };

AcknowledgementResult wait_for_acknowledgement(const Transaction& transaction, HANDLE child) {
    const ULONGLONG diagnostic_deadline = GetTickCount64() + kAckTimeoutMs;
    bool reported_slow_start = false;
    for (;;) {
        if (acknowledgement_matches(transaction)) return AcknowledgementResult::acknowledged;
        if (WaitForSingleObject(child, 0) == WAIT_OBJECT_0) return AcknowledgementResult::child_exited;
        if (!reported_slow_start && GetTickCount64() >= diagnostic_deadline) {
            write_result(&transaction, "awaiting-acknowledgement", "ack-timeout");
            reported_slow_start = true;
        }
        Sleep(kPollIntervalMs);
    }
}

void relaunch_rollback(const Transaction& transaction) {
    std::wstring command = quote_argument(transaction.target_path.wstring());
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (CreateProcessW(transaction.target_path.c_str(), command.data(), nullptr, nullptr, FALSE,
                       CREATE_UNICODE_ENVIRONMENT, nullptr, transaction.target_path.parent_path().c_str(),
                       &startup, &process)) {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
}

bool rollback(const Transaction& transaction, std::string& error) {
    if (ReplaceFileW(transaction.target_path.c_str(), transaction.backup_path.c_str(), nullptr,
                     REPLACEFILE_WRITE_THROUGH, nullptr, nullptr)) return true;
    error += ";rollback-" + windows_error(GetLastError());
    return false;
}

int run(const std::filesystem::path& transaction_path) {
    auto transaction = parse_transaction(transaction_path);
    if (!transaction) return 2;
    write_result(&*transaction, "waiting-for-wrapper");
    std::string error;
    if (!wait_for_wrapper(transaction->wrapper_pid, error)) {
        write_result(&*transaction, "failed", "wait-wrapper-" + error);
        return 3;
    }

    std::error_code filesystem_error;
    const auto replacement_size = std::filesystem::file_size(transaction->replacement_path, filesystem_error);
    const auto target_hash = sha512_file(transaction->target_path);
    const auto replacement_hash = sha512_file(transaction->replacement_path);
    if (filesystem_error || replacement_size != transaction->expected_replacement_size ||
        !target_hash || *target_hash != transaction->expected_target_sha512 ||
        !replacement_hash || *replacement_hash != transaction->expected_replacement_sha512) {
        DeleteFileW(transaction->replacement_path.c_str());
        write_result(&*transaction, "failed", "validation-failed");
        return 4;
    }

    DeleteFileW(transaction->acknowledgement_path.c_str());
    DeleteFileW(transaction->backup_path.c_str());
    if (!ReplaceFileW(transaction->target_path.c_str(), transaction->replacement_path.c_str(),
                      transaction->backup_path.c_str(), REPLACEFILE_WRITE_THROUGH, nullptr, nullptr)) {
        const std::string replace_error = windows_error(GetLastError());
        DeleteFileW(transaction->replacement_path.c_str());
        write_result(&*transaction, "failed", "replace-" + replace_error);
        return 5;
    }
    write_result(&*transaction, "replaced");

    auto child = launch_replacement(*transaction, error);
    if (!child) {
        const std::string launch_error = error;
        if (rollback(*transaction, error)) relaunch_rollback(*transaction);
        write_result(&*transaction, "rolled-back", "launch-" + launch_error + ";" + error);
        return 6;
    }
    const auto acknowledgement = wait_for_acknowledgement(*transaction, child->hProcess);
    CloseHandle(child->hProcess);
    if (acknowledgement == AcknowledgementResult::child_exited) {
        error = "replacement-exited-before-ack";
        if (rollback(*transaction, error)) relaunch_rollback(*transaction);
        write_result(&*transaction, "rolled-back", error);
        return 7;
    }

    if (!DeleteFileW(transaction->backup_path.c_str()) && GetLastError() != ERROR_FILE_NOT_FOUND) {
        write_result(&*transaction, "committed", "backup-delete-" + windows_error(GetLastError()));
        return 0;
    }
    write_result(&*transaction, "committed");
    return 0;
}
} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    int argc = 0;
    wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return 2;
    const int result = argc == 2 ? run(argv[1]) : 2;
    LocalFree(argv);
    return result;
}
