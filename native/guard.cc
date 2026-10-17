#include <node_api.h>
#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {

napi_value Fail(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}

napi_value Boolean(napi_env env, bool value) {
  napi_value result;
  if (napi_get_boolean(env, value, &result) != napi_ok) return nullptr;
  return result;
}

bool ReadPath(napi_env env, napi_callback_info info, std::string& path) {
  size_t argc = 2;
  napi_value args[2];
  napi_valuetype type;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok ||
      argc != 1 || napi_typeof(env, args[0], &type) != napi_ok || type != napi_string) {
    Fail(env, "INVALID_PATH", "One absolute file path is required.");
    return false;
  }
  size_t length;
  if (napi_get_value_string_utf8(env, args[0], nullptr, 0, &length) != napi_ok ||
      length == 0 || length > 32768) {
    Fail(env, "INVALID_PATH", "File path is empty or too long.");
    return false;
  }
  std::vector<char> buffer(length + 1);
  if (napi_get_value_string_utf8(env, args[0], buffer.data(), buffer.size(), &length) != napi_ok) return false;
  path.assign(buffer.data(), length);
#ifdef _WIN32
  bool absolute = path.size() > 2 && path[1] == ':' && (path[2] == '\\' || path[2] == '/');
#else
  bool absolute = path[0] == '/';
#endif
  if (!absolute || path.find('\0') != std::string::npos) {
    Fail(env, "INVALID_PATH", "Use an absolute local file path without NUL characters.");
    return false;
  }
  return true;
}

#ifdef _WIN32
std::wstring WidePath(const std::string& path) {
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), static_cast<int>(path.size()), nullptr, 0);
  if (length == 0) return {};
  std::wstring result(length, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), static_cast<int>(path.size()), result.data(), length);
  return result;
}
#endif

struct Guard {
#ifdef _WIN32
  HANDLE file = INVALID_HANDLE_VALUE;
  int Close() {
    if (file == INVALID_HANDLE_VALUE) return 0;
    // Closing the exact handle releases its lock. Never remove the pathname.
    if (!CloseHandle(file)) return -1;
    file = INVALID_HANDLE_VALUE;
    return 1;
  }
#else
  int file = -1;
  int Close() {
    if (file == -1) return 0;
    int closing = file;
    file = -1;
    // Do not retry close: an interrupted close can already have freed the fd.
    return close(closing) == 0 ? 1 : -1;
  }
#endif
  ~Guard() { Close(); }
};

struct Environment {
  std::vector<std::weak_ptr<Guard>> guards;
};

const napi_type_tag guardTag = {0x5188944b27034abc, 0x8315cd09ea1a1472};

void FinalizeGuard(napi_env, void* data, void*) {
  delete static_cast<std::shared_ptr<Guard>*>(data);
}

void FinalizeEnvironment(void* data) {
  auto* state = static_cast<Environment*>(data);
  for (const auto& weak : state->guards) {
    if (auto guard = weak.lock()) guard->Close();
  }
  delete state;
}

napi_value TryAcquire(napi_env env, napi_callback_info info) {
  std::string path;
  if (!ReadPath(env, info, path)) return nullptr;
  auto guard = std::make_shared<Guard>();
  bool busy = false;
#ifdef _WIN32
  std::wstring wide = WidePath(path);
  if (wide.empty()) return Fail(env, "INVALID_PATH", "File path is not valid UTF-8.");
  guard->file = CreateFileW(wide.c_str(), GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (guard->file == INVALID_HANDLE_VALUE) return Fail(env, "GUARD_OPEN", "Cannot open the guard file.");
  BY_HANDLE_FILE_INFORMATION metadata;
  if (!GetFileInformationByHandle(guard->file, &metadata) ||
      (metadata.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
      metadata.nNumberOfLinks != 1) {
    return Fail(env, "UNSAFE_GUARD", "The guard must be a regular, unlinked local file.");
  }
  OVERLAPPED offset = {};
  if (!LockFileEx(guard->file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &offset)) {
    if (GetLastError() != ERROR_LOCK_VIOLATION) return Fail(env, "GUARD_LOCK", "The OS refused the guard lock.");
    busy = true;
  }
#else
  guard->file = open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (guard->file == -1) return Fail(env, "GUARD_OPEN", "Cannot open the guard file.");
  struct stat metadata;
  if (fstat(guard->file, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
      metadata.st_nlink != 1 || metadata.st_uid != geteuid() || (metadata.st_mode & 0077)) {
    return Fail(env, "UNSAFE_GUARD", "The guard must be a private regular file owned by this OS user.");
  }
  int lockResult;
  do { lockResult = flock(guard->file, LOCK_EX | LOCK_NB); } while (lockResult == -1 && errno == EINTR);
  if (lockResult == -1) {
    if (errno != EWOULDBLOCK && errno != EAGAIN) return Fail(env, "GUARD_LOCK", "The OS refused the guard lock.");
    busy = true;
  }
#endif
  if (busy) {
    napi_value result;
    napi_get_null(env, &result);
    return result;
  }
  Environment* state;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, reinterpret_cast<void**>(&state)) != napi_ok) return nullptr;
  state->guards.erase(std::remove_if(state->guards.begin(), state->guards.end(),
      [](const auto& weak) { return weak.expired(); }), state->guards.end());
  state->guards.push_back(guard);
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) return nullptr;
  auto* reference = new std::shared_ptr<Guard>(guard);
  if (napi_wrap(env, result, reference, FinalizeGuard, nullptr, nullptr) != napi_ok) {
    delete reference;
    return nullptr;
  }
  if (napi_type_tag_object(env, result, &guardTag) != napi_ok) return nullptr;
  return result;
}

napi_value Release(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  bool valid = false;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_check_object_type_tag(env, args[0], &guardTag, &valid) != napi_ok || !valid) {
    return Fail(env, "INVALID_GUARD", "Release requires the original guard handle.");
  }
  std::shared_ptr<Guard>* guard;
  if (napi_unwrap(env, args[0], reinterpret_cast<void**>(&guard)) != napi_ok) return nullptr;
  int result = (*guard)->Close();
  if (result < 0) return Fail(env, "RELEASE_UNKNOWN", "The OS did not confirm guard release.");
  return Boolean(env, result == 1);
}

napi_value Initialize(napi_env env, napi_value exports) {
  auto* state = new Environment();
  if (napi_add_env_cleanup_hook(env, FinalizeEnvironment, state) != napi_ok) {
    delete state;
    return nullptr;
  }
  napi_property_descriptor methods[] = {
      {"tryAcquire", nullptr, TryAcquire, nullptr, nullptr, nullptr, napi_default, state},
      {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr}};
  if (napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok) return nullptr;
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
