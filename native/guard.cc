#include <node_api.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sys/mount.h>
#include <sys/sysctl.h>
#else
#include <sys/vfs.h>
#endif
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

napi_value Null(napi_env env) {
  napi_value result;
  if (napi_get_null(env, &result) != napi_ok) return nullptr;
  return result;
}

bool ReadPath(napi_env env, napi_callback_info info, std::string& path, size_t expected = 1, napi_value* second = nullptr) {
  size_t argc = 3;
  napi_value args[3];
  napi_valuetype type;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok ||
      argc != expected || napi_typeof(env, args[0], &type) != napi_ok || type != napi_string) {
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
  if (second) *second = args[1];
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

bool CheckLocalDirectory(napi_env env, const std::string& path) {
#ifdef _WIN32
  std::wstring wide = WidePath(path);
  if (wide.empty() || GetDriveTypeW(wide.substr(0, 3).c_str()) != DRIVE_FIXED) {
    Fail(env, "UNSUPPORTED_FILESYSTEM", "The guard needs a fixed local volume.");
    return false;
  }
  for (size_t i = 3; i <= wide.size(); ++i) {
    if (i != wide.size() && wide[i] != L'\\' && wide[i] != L'/') continue;
    DWORD attributes = GetFileAttributesW(wide.substr(0, i).c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
      Fail(env, "UNSUPPORTED_FILESYSTEM", "Redirected or unavailable guard directories are unsupported.");
      return false;
    }
  }
  HANDLE directory = CreateFileW(wide.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (directory == INVALID_HANDLE_VALUE) {
    Fail(env, "UNSUPPORTED_FILESYSTEM", "Cannot inspect the local guard directory.");
    return false;
  }
  wchar_t filesystem[32];
  BY_HANDLE_FILE_INFORMATION metadata;
  bool supported = GetFileInformationByHandle(directory, &metadata) &&
      (metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
      GetVolumeInformationByHandleW(directory, nullptr, 0, nullptr, nullptr, nullptr, filesystem, 32) &&
      wcscmp(filesystem, L"NTFS") == 0;
  CloseHandle(directory);
#else
  char* canonical = realpath(path.c_str(), nullptr);
  bool samePath = canonical && path == canonical;
  free(canonical);
  if (!samePath) {
    Fail(env, "UNSUPPORTED_FILESYSTEM", "Use the canonical local directory without redirects.");
    return false;
  }
  int directory = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory == -1) {
    Fail(env, "UNSUPPORTED_FILESYSTEM", "Cannot inspect the local guard directory.");
    return false;
  }
  struct statfs filesystem;
  bool supported = fstatfs(directory, &filesystem) == 0;
#ifdef __APPLE__
  supported = supported && (filesystem.f_flags & MNT_LOCAL) &&
      !(filesystem.f_flags & MNT_RDONLY) && std::string(filesystem.f_fstypename) == "apfs";
#else
  // Explicit initial local-filesystem allowlist: ext4, XFS, Btrfs. Volatile,
  // FUSE, overlay and network filesystems do not satisfy the storage gate.
  supported = supported && (filesystem.f_type == 0xEF53 ||
      filesystem.f_type == 0x58465342 || filesystem.f_type == 0x9123683E);
#endif
  close(directory);
#endif
  if (!supported) Fail(env, "UNSUPPORTED_FILESYSTEM", "This filesystem is outside the validated local guard targets.");
  return supported;
}

napi_value AssertLocalDirectory(napi_env env, napi_callback_info info) {
  std::string path;
  if (!ReadPath(env, info, path) || !CheckLocalDirectory(env, path)) return nullptr;
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return nullptr;
  return result;
}

std::string ParentPath(const std::string& path) {
#ifdef _WIN32
  size_t separator = path.find_last_of("/\\");
  return separator == 2 ? path.substr(0, 3) : path.substr(0, separator);
#else
  size_t separator = path.find_last_of('/');
  return separator == 0 ? "/" : path.substr(0, separator);
#endif
}

std::string TemporaryPath(const std::string& path) {
  static std::atomic<uint64_t> sequence{0};
#ifdef _WIN32
  auto pid = GetCurrentProcessId();
#else
  auto pid = getpid();
#endif
  return path + ".tmp-" + std::to_string(pid) + "-" +
      std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-" +
      std::to_string(sequence.fetch_add(1));
}

#ifdef _WIN32
struct PrivateSecurity {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes = {sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
  bool Initialize(bool directory) {
    HANDLE token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    std::vector<BYTE> data(size);
    bool read = GetTokenInformation(token, TokenUser, data.data(), size, &size);
    CloseHandle(token);
    if (!read) return false;
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &sid)) return false;
    std::wstring rule = std::wstring(directory ? L"D:P(A;OICI;FA;;;" : L"D:P(A;;FA;;;") + sid + L")";
    LocalFree(sid);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(rule.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return false;
    attributes.lpSecurityDescriptor = descriptor;
    return true;
  }
  ~PrivateSecurity() { if (descriptor) LocalFree(descriptor); }
};

bool IsPrivate(const std::string& path, bool directory) {
  HANDLE file = CreateFileW(WidePath(path).c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PSID owner = nullptr;
  PACL acl = nullptr;
  BY_HANDLE_FILE_INFORMATION metadata;
  bool valid = GetFileInformationByHandle(file, &metadata) &&
      !(metadata.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
      (directory ? (metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 :
      (!(metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && metadata.nNumberOfLinks == 1)) &&
      GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS;
  HANDLE token;
  if (valid && OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    std::vector<BYTE> data(size);
    valid = GetTokenInformation(token, TokenUser, data.data(), size, &size);
    CloseHandle(token);
    PSID user = valid ? reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid : nullptr;
    valid = valid && owner && EqualSid(owner, user) && acl && acl->AceCount == 1;
    void* rawAce = nullptr;
    if (valid) valid = GetAce(acl, 0, &rawAce);
    if (valid) {
      auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
      valid = ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && EqualSid(&ace->SidStart, user);
    }
  } else valid = false;
  if (descriptor) LocalFree(descriptor);
  CloseHandle(file);
  return valid;
}
#else
bool IsPrivate(const std::string& path, bool directory) {
  struct stat metadata;
  return lstat(path.c_str(), &metadata) == 0 && metadata.st_uid == geteuid() &&
      !(metadata.st_mode & 0077) && (directory ? S_ISDIR(metadata.st_mode) :
      (S_ISREG(metadata.st_mode) && metadata.st_nlink == 1));
}

bool SyncFile(int file) {
#ifdef __APPLE__
  int result;
  do { result = fcntl(file, F_FULLFSYNC); } while (result == -1 && errno == EINTR);
#else
  int result;
  do { result = fsync(file); } while (result == -1 && errno == EINTR);
#endif
  return result == 0;
}

bool SyncDirectory(const std::string& path) {
  int directory = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory == -1) return false;
  int result;
  do { result = fsync(directory); } while (result == -1 && errno == EINTR);
  close(directory);
  return result == 0;
}
#endif

napi_value EnsurePrivateDirectory(napi_env env, napi_callback_info info) {
  std::string path;
  if (!ReadPath(env, info, path) || !CheckLocalDirectory(env, ParentPath(path))) return nullptr;
#ifdef _WIN32
  if (GetFileAttributesW(WidePath(path).c_str()) != INVALID_FILE_ATTRIBUTES) {
#else
  struct stat metadata;
  if (lstat(path.c_str(), &metadata) == 0) {
#endif
    if (!CheckLocalDirectory(env, path) || !IsPrivate(path, true)) {
      return Fail(env, "UNSAFE_PERMISSIONS", "Existing storage directory is not private to this OS user.");
    }
    return Boolean(env, false);
  }
  std::string temporary = TemporaryPath(path);
#ifdef _WIN32
  PrivateSecurity security;
  if (!security.Initialize(true) || !CreateDirectoryW(WidePath(temporary).c_str(), &security.attributes)) {
    return Fail(env, "DIRECTORY_CREATE", "Cannot create a private storage directory.");
  }
  bool published = MoveFileExW(WidePath(temporary).c_str(), WidePath(path).c_str(), MOVEFILE_WRITE_THROUGH);
  DWORD error = published ? ERROR_SUCCESS : GetLastError();
  if (!published) RemoveDirectoryW(WidePath(temporary).c_str());
  if (!published && (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS) &&
      CheckLocalDirectory(env, path) && IsPrivate(path, true)) return Boolean(env, false);
  if (!published) return Fail(env, "DIRECTORY_PUBLICATION", "Storage directory publication was not confirmed.");
#else
  // mkdir is atomic and never replaces an existing directory. Flush its name
  // before initialization can put authoritative records inside it.
  if (mkdir(path.c_str(), 0700) != 0) {
    if (errno == EEXIST && CheckLocalDirectory(env, path) && IsPrivate(path, true)) return Boolean(env, false);
    return Fail(env, "DIRECTORY_CREATE", "Cannot create a private storage directory.");
  }
  if (!SyncDirectory(ParentPath(path))) return Fail(env, "DIRECTORY_PUBLICATION", "Storage directory publication was not confirmed.");
#endif
  return Boolean(env, true);
}

napi_value PublishRecord(napi_env env, napi_callback_info info) {
  std::string path;
  napi_value value;
  if (!ReadPath(env, info, path, 2, &value) || !CheckLocalDirectory(env, ParentPath(path))) return nullptr;
  if (!IsPrivate(ParentPath(path), true)) return Fail(env, "UNSAFE_PERMISSIONS", "Recovery records need a private OS-user directory.");
  size_t size;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size > 65536) {
    return Fail(env, "INVALID_RECORD", "Recovery records must be complete UTF-8 text up to 64 KiB.");
  }
  std::vector<char> content(size + 1);
  if (napi_get_value_string_utf8(env, value, content.data(), content.size(), &size) != napi_ok) return nullptr;
  std::string temporary = TemporaryPath(path);
#ifdef _WIN32
  if (GetFileAttributesW(WidePath(path).c_str()) != INVALID_FILE_ATTRIBUTES && !IsPrivate(path, false)) {
    return Fail(env, "UNSAFE_RECORD", "The existing recovery record is not a private regular file.");
  }
  PrivateSecurity security;
  if (!security.Initialize(false)) return Fail(env, "RECORD_PERMISSIONS", "Cannot establish private record permissions.");
  HANDLE file = CreateFileW(WidePath(temporary).c_str(), GENERIC_WRITE, FILE_SHARE_READ,
      &security.attributes, CREATE_NEW, FILE_FLAG_WRITE_THROUGH, nullptr);
  if (file == INVALID_HANDLE_VALUE) return Fail(env, "RECORD_CREATE", "Cannot create a recovery record candidate.");
  DWORD written = 0;
  bool flushed = WriteFile(file, content.data(), static_cast<DWORD>(size), &written, nullptr) &&
      written == size && FlushFileBuffers(file);
  bool closed = CloseHandle(file);
  if (!flushed || !closed) {
    DeleteFileW(WidePath(temporary).c_str());
    return Fail(env, "RECORD_FLUSH", "The recovery candidate was not durably flushed.");
  }
  if (!MoveFileExW(WidePath(temporary).c_str(), WidePath(path).c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(WidePath(temporary).c_str());
    return Fail(env, "RECORD_PUBLICATION", "Recovery record publication was not confirmed.");
  }
  file = CreateFileW(WidePath(path).c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) return Fail(env, "RECORD_PUBLICATION", "Cannot confirm the published recovery record.");
  bool complete = FlushFileBuffers(file);
  bool finalClosed = CloseHandle(file);
  if (!complete || !finalClosed) return Fail(env, "RECORD_PUBLICATION", "Published recovery durability is uncertain.");
#else
  struct stat existing;
  if (lstat(path.c_str(), &existing) == 0 && !IsPrivate(path, false)) {
    return Fail(env, "UNSAFE_RECORD", "The existing recovery record is not a private regular file.");
  }
  int file = open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (file == -1) return Fail(env, "RECORD_CREATE", "Cannot create a recovery record candidate.");
  size_t offset = 0;
  while (offset < size) {
    ssize_t written = write(file, content.data() + offset, size - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) break;
    offset += static_cast<size_t>(written);
  }
  bool flushed = offset == size && SyncFile(file);
  bool closed = close(file) == 0;
  if (!flushed || !closed) {
    unlink(temporary.c_str());
    return Fail(env, "RECORD_FLUSH", "The recovery candidate was not durably flushed.");
  }
  if (rename(temporary.c_str(), path.c_str()) != 0) {
    unlink(temporary.c_str());
    return Fail(env, "RECORD_PUBLICATION", "Recovery record publication was not confirmed.");
  }
  bool directoryFlushed = SyncDirectory(ParentPath(path));
#ifdef __APPLE__
  file = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  bool barrier = file != -1 && SyncFile(file);
  if (file != -1) close(file);
  directoryFlushed = directoryFlushed && barrier;
#endif
  if (!directoryFlushed) return Fail(env, "RECORD_PUBLICATION", "Published recovery directory durability is uncertain.");
#endif
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return nullptr;
  return result;
}

struct Guard {
  std::string path;
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
#ifdef _WIN32
  size_t separator = path.find_last_of("/\\");
#else
  size_t separator = path.find_last_of('/');
#endif
  if (!CheckLocalDirectory(env, path.substr(0, separator))) return nullptr;
  auto guard = std::make_shared<Guard>();
  guard->path = path;
  bool busy = false;
  bool created = false;
#ifdef _WIN32
  std::wstring wide = WidePath(path);
  if (wide.empty()) return Fail(env, "INVALID_PATH", "File path is not valid UTF-8.");
  guard->file = CreateFileW(wide.c_str(), GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  created = guard->file != INVALID_HANDLE_VALUE && GetLastError() != ERROR_ALREADY_EXISTS;
  if (guard->file == INVALID_HANDLE_VALUE) return Fail(env, "GUARD_OPEN", "Cannot open the guard file.");
  BY_HANDLE_FILE_INFORMATION metadata;
  if (!GetFileInformationByHandle(guard->file, &metadata) ||
      (metadata.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
      metadata.nNumberOfLinks != 1) {
    return Fail(env, "UNSAFE_GUARD", "The guard must be a regular local file with one link.");
  }
  OVERLAPPED offset = {};
  if (!LockFileEx(guard->file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &offset)) {
    if (GetLastError() != ERROR_LOCK_VIOLATION) return Fail(env, "GUARD_LOCK", "The OS refused the guard lock.");
    busy = true;
  }
#else
  guard->file = open(path.c_str(), O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  created = guard->file != -1;
  if (guard->file == -1 && errno == EEXIST) guard->file = open(path.c_str(), O_RDWR | O_CLOEXEC | O_NOFOLLOW);
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
    return Null(env);
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
  napi_property_descriptor property = {"created", nullptr, nullptr, nullptr, nullptr, Boolean(env, created), napi_default, nullptr};
  if (napi_define_properties(env, result, 1, &property) != napi_ok) return nullptr;
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

napi_value AssertHeld(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  bool valid = false;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_check_object_type_tag(env, args[0], &guardTag, &valid) != napi_ok || !valid) {
    return Fail(env, "INVALID_GUARD", "Validation requires the original guard handle.");
  }
  std::shared_ptr<Guard>* reference;
  if (napi_unwrap(env, args[0], reinterpret_cast<void**>(&reference)) != napi_ok) return nullptr;
  const auto& guard = *reference;
  if (!CheckLocalDirectory(env, ParentPath(guard->path))) return nullptr;
#ifdef _WIN32
  // The live handle denies delete/rename sharing. Check its link and kind too.
  BY_HANDLE_FILE_INFORMATION metadata;
  if (guard->file == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(guard->file, &metadata) ||
      metadata.nNumberOfLinks != 1 || (metadata.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) {
    return Fail(env, "STALE_GUARD", "The live guard is unavailable or replaced.");
  }
#else
  struct stat held, named;
  if (guard->file == -1 || fstat(guard->file, &held) != 0 || lstat(guard->path.c_str(), &named) != 0 ||
      !S_ISREG(named.st_mode) || held.st_dev != named.st_dev || held.st_ino != named.st_ino ||
      named.st_nlink != 1 || named.st_uid != geteuid() || (named.st_mode & 0077)) {
    return Fail(env, "STALE_GUARD", "The guard pathname no longer names this live lock.");
  }
#endif
  return Boolean(env, true);
}

napi_value ProcessIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  double number;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_double(env, args[0], &number) != napi_ok || !std::isfinite(number) ||
      number < 1 || number > 2147483647 || number != std::floor(number)) {
    return Fail(env, "INVALID_PID", "Process identity needs one positive integer PID.");
  }
  int pid = static_cast<int>(number);
  std::string start;
#ifdef _WIN32
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) {
    if (GetLastError() == ERROR_INVALID_PARAMETER) return Null(env);
    return Fail(env, "PROCESS_IDENTITY_UNKNOWN", "The OS refused process identity inspection.");
  }
  FILETIME creation, exit, kernel, user;
  DWORD status;
  bool known = GetProcessTimes(process, &creation, &exit, &kernel, &user) && GetExitCodeProcess(process, &status);
  CloseHandle(process);
  if (!known) return Fail(env, "PROCESS_IDENTITY_UNKNOWN", "Cannot read process creation time.");
  if (status != STILL_ACTIVE) return Null(env);
  ULARGE_INTEGER time;
  time.LowPart = creation.dwLowDateTime;
  time.HighPart = creation.dwHighDateTime;
  start = std::to_string(time.QuadPart);
#elif defined(__APPLE__)
  struct proc_bsdinfo process = {};
  int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process, sizeof(process));
  if (bytes == 0 && errno == ESRCH) return Null(env);
  if (bytes != sizeof(process)) return Fail(env, "PROCESS_IDENTITY_UNKNOWN", "Cannot read OS process-start identity.");
  // kern.boottime changes when the wall clock is corrected. Use the immutable
  // boot-session UUID with the process's recorded start metadata instead.
  char boot[128] = {};
  size_t size = sizeof(boot);
  if (sysctlbyname("kern.bootsessionuuid", boot, &size, nullptr, 0) != 0 || size == 0 || size >= sizeof(boot) || boot[0] == '\0') {
    return Fail(env, "PROCESS_IDENTITY_UNKNOWN", "Cannot read OS boot-session identity.");
  }
  start = std::string(boot) + ":" + std::to_string(process.pbi_start_tvsec) + ":" + std::to_string(process.pbi_start_tvusec);
#else
  std::ifstream file("/proc/" + std::to_string(pid) + "/stat");
  if (!file) {
    if (errno == ENOENT || errno == ESRCH) return Null(env);
    return Fail(env, "PROCESS_IDENTITY_UNKNOWN", "Cannot read OS process-start identity.");
  }
  std::string line;
  std::getline(file, line);
  size_t end = line.rfind(')');
  if (end == std::string::npos) return Fail(env, "PROCESS_IDENTITY_UNKNOWN", "Malformed OS process identity.");
  std::istringstream fields(line.substr(end + 1));
  std::string ticks;
  for (int field = 3; field <= 22; ++field) {
    if (!(fields >> ticks)) return Fail(env, "PROCESS_IDENTITY_UNKNOWN", "Incomplete OS process identity.");
  }
  std::ifstream bootFile("/proc/sys/kernel/random/boot_id");
  std::string boot;
  if (!std::getline(bootFile, boot) || boot.empty()) return Fail(env, "PROCESS_IDENTITY_UNKNOWN", "Cannot read OS boot identity.");
  start = boot + ":" + ticks;
#endif
  napi_value result, pidValue, startValue;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_int32(env, pid, &pidValue) != napi_ok ||
      napi_create_string_utf8(env, start.data(), start.size(), &startValue) != napi_ok ||
      napi_set_named_property(env, result, "pid", pidValue) != napi_ok ||
      napi_set_named_property(env, result, "start", startValue) != napi_ok) return nullptr;
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  auto* state = new Environment();
  if (napi_add_env_cleanup_hook(env, FinalizeEnvironment, state) != napi_ok) {
    delete state;
    return nullptr;
  }
  napi_property_descriptor methods[] = {
      {"tryAcquire", nullptr, TryAcquire, nullptr, nullptr, nullptr, napi_default, state},
      {"assertHeld", nullptr, AssertHeld, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"processIdentity", nullptr, ProcessIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"assertLocalDirectory", nullptr, AssertLocalDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"ensurePrivateDirectory", nullptr, EnsurePrivateDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"publishRecord", nullptr, PublishRecord, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr}};
  if (napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok) return nullptr;
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
