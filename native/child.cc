#include <node_api.h>
#include <algorithm>
#include <memory>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif
#endif

namespace {
napi_value Error(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message); return nullptr;
}
bool String(napi_env env, napi_value value, std::string& result) {
  napi_valuetype type; size_t size;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size > 32768) return false;
  std::vector<char> buffer(size + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &size) != napi_ok) return false;
  result.assign(buffer.data(), size); return result.find('\0') == std::string::npos;
}
napi_value Number(napi_env env, int value) { napi_value result; napi_create_int32(env, value, &result); return result; }
struct Child {
  int pid = 0;
  bool started = false, exited = false, closed = false;
  int status = 0;
#ifdef _WIN32
  HANDLE process = nullptr, thread = nullptr, job = nullptr;
  void Close() {
    if (closed) return; closed = true;
    // Kill-on-close contains the whole Windows job, including descendants.
    if (job) CloseHandle(job);
    if (thread) CloseHandle(thread);
    if (process) CloseHandle(process);
    job = thread = process = nullptr;
  }
#else
  int gate = -1;
  void Close() {
    if (closed) return; closed = true;
    // EOF cancels a prepared child. A running Git may survive host death;
    // its durable armed record remains a recovery barrier.
    if (gate != -1) close(gate);
    gate = -1;
  }
#endif
  ~Child() { Close(); }
};
struct Children { std::vector<std::weak_ptr<Child>> handles; };
const napi_type_tag childTag = {0xa3be86e33c024b11, 0x82fbc753cc586a07};
void Finalize(napi_env, void* value, void*) { delete static_cast<std::shared_ptr<Child>*>(value); }
void Cleanup(void* value) {
  auto* children = static_cast<Children*>(value);
  for (const auto& weak : children->handles) if (auto child = weak.lock()) child->Close();
  delete children;
}
std::shared_ptr<Child> Handle(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; bool tagged = false;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_check_object_type_tag(env, args[0], &childTag, &tagged) != napi_ok || !tagged) {
    Error(env, "INVALID_CHILD", "Use the original prepared-child handle."); return {};
  }
  std::shared_ptr<Child>* reference;
  if (napi_unwrap(env, args[0], reinterpret_cast<void**>(&reference)) != napi_ok) return {};
  if ((*reference)->closed) { Error(env, "CHILD_CLOSED", "The child handle is closed."); return {}; }
  return *reference;
}
#ifdef _WIN32
std::wstring Wide(const std::string& value) {
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring result(size, 0);
  if (size) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
  return result;
}
std::wstring Quote(const std::wstring& value) {
  std::wstring result = L"\""; size_t slashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') { ++slashes; continue; }
    result.append(slashes * (character == L'"' ? 2 : 1), L'\\'); slashes = 0;
    if (character == L'"') result += L'\\';
    result += character;
  }
  result.append(slashes * 2, L'\\'); return result + L"\"";
}
#endif
#ifndef _WIN32
int AboveStdio(int descriptor) {
  if (descriptor >= 3) return descriptor;
  int isolated = fcntl(descriptor, F_DUPFD_CLOEXEC, 3);
  close(descriptor);
  return isolated;
}
void CloseInheritedDescriptor(int descriptor) {
#ifdef __linux__
  // Chromium interposes libc close() with ownership checks for the parent's
  // ScopedFDs. Only this forked child discards those inherited descriptors;
  // its copied ownership table must not trap before exec. Use the kernel
  // operation here, without binding to a private Chromium reset API. Parent
  // cleanup continues through ordinary close().
  syscall(SYS_close, descriptor);
#else
  close(descriptor);
#endif
}
#endif
napi_value Prepare(napi_env env, napi_callback_info info) {
  size_t count = 6; napi_value args[6]; Children* children;
  if (napi_get_cb_info(env, info, &count, args, nullptr, reinterpret_cast<void**>(&children)) != napi_ok || count != 5)
    return Error(env, "INVALID_CHILD", "Prepare needs executable, arguments, directory and environment.");
  std::string executable, directory, identity; bool array; uint32_t length;
  if (!String(env, args[4], identity) || identity.size() != 36 || identity.find_first_not_of("0123456789abcdef-") != std::string::npos)
    return Error(env, "INVALID_CHILD", "A host-owned operation identity is required.");
  if (!String(env, args[0], executable) || !String(env, args[2], directory) || executable.empty() || directory.empty() ||
      napi_is_array(env, args[1], &array) != napi_ok || !array || napi_get_array_length(env, args[1], &length) != napi_ok || length > 128)
    return Error(env, "INVALID_CHILD", "Child paths and arguments are unsupported.");
  std::vector<std::string> arguments = {executable}, environment;
  for (uint32_t i = 0; i < length; ++i) {
    napi_value value; std::string argument;
    if (napi_get_element(env, args[1], i, &value) != napi_ok || !String(env, value, argument)) return Error(env, "INVALID_CHILD", "Child argument is invalid.");
    arguments.push_back(argument);
  }
  napi_value keys;
  if (napi_get_property_names(env, args[3], &keys) != napi_ok || napi_get_array_length(env, keys, &length) != napi_ok || length > 1024)
    return Error(env, "INVALID_CHILD", "Child environment is invalid.");
  size_t total = 0;
  for (uint32_t i = 0; i < length; ++i) {
    napi_value keyValue, value; std::string key, entry;
    if (napi_get_element(env, keys, i, &keyValue) != napi_ok || !String(env, keyValue, key) || key.empty() || key.find('=') != std::string::npos ||
        napi_get_property(env, args[3], keyValue, &value) != napi_ok || !String(env, value, entry)) return Error(env, "INVALID_CHILD", "Child environment entry is invalid.");
    environment.push_back(key + "=" + entry); total += environment.back().size();
  }
  if (total > 262144) return Error(env, "INVALID_CHILD", "Child environment is too large.");
  auto child = std::make_shared<Child>();
#ifdef _WIN32
  std::wstring command;
  for (const auto& argument : arguments) { if (!command.empty()) command += L' '; command += Quote(Wide(argument)); }
  std::vector<std::wstring> entries;
  for (const auto& entry : environment) entries.push_back(Wide(entry));
  std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) { return _wcsicmp(left.c_str(), right.c_str()) < 0; });
  std::wstring block;
  for (const auto& entry : entries) { block += entry; block += L'\0'; } block += L'\0';
  child->job = CreateJobObjectW(nullptr, (L"Local\\CodeReviewWorkbench-" + Wide(identity)).c_str());
  if (child->job && GetLastError() == ERROR_ALREADY_EXISTS) return Error(env, "CHILD_PREPARE", "The operation job already exists.");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!child->job || !SetInformationJobObject(child->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    return Error(env, "CHILD_PREPARE", "Cannot establish the child job.");
  STARTUPINFOW startup = {}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION process = {};
  if (!CreateProcessW(Wide(executable).c_str(), command.data(), nullptr, nullptr, FALSE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, block.data(), Wide(directory).c_str(), &startup, &process))
    return Error(env, "CHILD_PREPARE", "Cannot create a suspended child.");
  child->process = process.hProcess; child->thread = process.hThread; child->pid = static_cast<int>(process.dwProcessId);
  if (!AssignProcessToJobObject(child->job, child->process)) {
    TerminateProcess(child->process, 127);
    return Error(env, "CHILD_PREPARE", "Cannot contain the suspended child.");
  }
#else
  if (executable[0] != '/' || directory[0] != '/') return Error(env, "INVALID_CHILD", "Child paths must be absolute.");
  int gates[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, gates) != 0) return Error(env, "CHILD_PREPARE", "Cannot create the child gate.");
  // Extension hosts can have closed stdio. Never let dup2 below overwrite a
  // start socket, or leave a same-fd /dev/null descriptor close-on-exec.
  gates[0] = AboveStdio(gates[0]); gates[1] = AboveStdio(gates[1]);
  if (gates[0] == -1 || gates[1] == -1) {
    if (gates[0] != -1) close(gates[0]); if (gates[1] != -1) close(gates[1]);
    return Error(env,"CHILD_PREPARE","Cannot isolate child descriptors.");
  }
  if (fcntl(gates[0], F_SETFD, FD_CLOEXEC) == -1 || fcntl(gates[1], F_SETFD, FD_CLOEXEC) == -1) {
    close(gates[0]); close(gates[1]); return Error(env,"CHILD_PREPARE","Cannot isolate the child gate.");
  }
#ifdef __APPLE__
  int noSignal = 1;
  if (setsockopt(gates[0], SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal)) != 0) {
    close(gates[0]); close(gates[1]); return Error(env,"CHILD_PREPARE","Cannot establish signal-safe child start.");
  }
#endif
  int nullFile = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (nullFile != -1) nullFile = AboveStdio(nullFile);
  if (nullFile == -1) { close(gates[0]); close(gates[1]); return Error(env, "CHILD_PREPARE", "Cannot establish child output."); }
  std::vector<char*> argv, envp;
  for (auto& argument : arguments) argv.push_back(argument.data()); argv.push_back(nullptr);
  for (auto& entry : environment) envp.push_back(entry.data()); envp.push_back(nullptr);
  long maximum = sysconf(_SC_OPEN_MAX);
  if (maximum < 0) { close(nullFile); close(gates[0]); close(gates[1]); return Error(env, "CHILD_PREPARE", "Cannot establish descriptor closure."); }
  pid_t pid = fork();
  if (pid == 0) {
    // Only async-signal-safe operations after fork in this multithreaded host.
    if (setpgid(0, 0) != 0 || chdir(directory.c_str()) != 0) _exit(127);
    for (int fd = 0; fd < 3; ++fd) if (dup2(nullFile, fd) == -1) _exit(127);
    for (int fd = 3; fd < maximum; ++fd) if (fd != gates[1]) CloseInheritedDescriptor(fd);
    char byte = 0; ssize_t received;
    do { received = read(gates[1], &byte, 1); } while (received == -1 && errno == EINTR);
    CloseInheritedDescriptor(gates[1]);
    if (received != 1 || byte != 'G') _exit(126);
    execve(executable.c_str(), argv.data(), envp.data()); _exit(127);
  }
  close(nullFile); close(gates[1]);
  if (pid == -1) { close(gates[0]); return Error(env, "CHILD_PREPARE", "Cannot create the gated child."); }
  child->gate = gates[0]; child->pid = pid;
#endif
  children->handles.erase(std::remove_if(children->handles.begin(),children->handles.end(),[](const auto& weak){return weak.expired();}),children->handles.end());
  children->handles.push_back(child);
  napi_value result; napi_create_object(env, &result);
  auto* reference = new std::shared_ptr<Child>(child);
  if (napi_wrap(env, result, reference, Finalize, nullptr, nullptr) != napi_ok) { delete reference; return nullptr; }
  napi_type_tag_object(env, result, &childTag);
  napi_property_descriptor property = {"pid", nullptr, nullptr, nullptr, nullptr, Number(env, child->pid), napi_default, nullptr};
  napi_define_properties(env, result, 1, &property); return result;
}
napi_value Start(napi_env env, napi_callback_info info) {
  auto child = Handle(env, info); if (!child) return nullptr;
  if (child->started || child->exited) return Error(env, "CHILD_STATE", "The child cannot be started again.");
#ifdef _WIN32
  if (ResumeThread(child->thread) == static_cast<DWORD>(-1)) return Error(env, "CHILD_UNKNOWN", "Child start was not confirmed.");
#else
  char byte = 'G';
#ifdef MSG_NOSIGNAL
  int flags = MSG_NOSIGNAL;
#else
  int flags = 0;
#endif
  ssize_t sent;
  do { sent = send(child->gate, &byte, 1, flags); } while (sent == -1 && errno == EINTR);
  if (sent != 1) return Error(env, "CHILD_UNKNOWN", "Child start was not confirmed.");
  close(child->gate); child->gate = -1;
#endif
  child->started = true; return Number(env, child->pid);
}
napi_value Poll(napi_env env, napi_callback_info info) {
  auto child = Handle(env, info); if (!child) return nullptr;
  if (!child->exited) {
#ifdef _WIN32
    DWORD state = WaitForSingleObject(child->process, 0), code;
    if (state == WAIT_FAILED) return Error(env, "CHILD_UNKNOWN", "Cannot inspect child settlement.");
    if (state == WAIT_OBJECT_0) {
      if (!GetExitCodeProcess(child->process, &code)) return Error(env, "CHILD_UNKNOWN", "Cannot inspect child exit.");
      child->exited = true; child->status = static_cast<int>(code);
    }
#else
    int status; pid_t result;
    do { result = waitpid(child->pid, &status, WNOHANG); } while (result == -1 && errno == EINTR);
    if (result == -1) return Error(env, "CHILD_UNKNOWN", "Cannot establish child settlement.");
    if (result == child->pid) { child->exited = true; child->status = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status); }
#endif
  }
  bool settled = child->exited;
#ifdef _WIN32
  if (settled) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    if (!QueryInformationJobObject(child->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr))
      return Error(env, "CHILD_UNKNOWN", "Cannot establish job settlement.");
    settled = accounting.ActiveProcesses == 0;
  }
#else
  if (settled) {
    if (kill(-child->pid, 0) == 0) settled = false;
    else if (errno != ESRCH) return Error(env, "CHILD_UNKNOWN", "Cannot establish process-group settlement.");
  }
#endif
  napi_value result; napi_create_object(env, &result);
  napi_value flag; napi_get_boolean(env, settled, &flag); napi_set_named_property(env, result, "settled", flag);
  if (settled) napi_set_named_property(env, result, "exitCode", Number(env, child->status));
  return result;
}
napi_value Close(napi_env env, napi_callback_info info) {
  auto child = Handle(env, info); if (!child) return nullptr;
  child->Close(); return Number(env, 1);
}
napi_value Cancel(napi_env env, napi_callback_info info) {
  auto child = Handle(env, info); if (!child) return nullptr;
  if (child->started) return Error(env, "CHILD_STATE", "A running operation cannot be treated as cancelled.");
#ifdef _WIN32
  if (!TerminateJobObject(child->job, 126)) return Error(env, "CHILD_UNKNOWN", "Cannot confirm prepared-child cancellation.");
#else
  if (kill(child->pid, SIGKILL) != 0 && errno != ESRCH) return Error(env, "CHILD_UNKNOWN", "Cannot request prepared-child cancellation.");
  if (child->gate != -1) close(child->gate);
  child->gate = -1;
#endif
  child->started = true; return Number(env, 1);
}
napi_value GroupSettled(napi_env env, napi_callback_info info) {
  size_t count = 3; napi_value args[3]; int32_t pid; std::string identity;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 2 ||
      napi_get_value_int32(env, args[0], &pid) != napi_ok || pid < 1 || !String(env,args[1],identity) ||
      identity.size() != 36 || identity.find_first_not_of("0123456789abcdef-") != std::string::npos)
    return Error(env,"INVALID_CHILD","Process-group inspection needs the recorded identity.");
  bool settled;
#ifdef _WIN32
  HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, (L"Local\\CodeReviewWorkbench-" + Wide(identity)).c_str());
  if (!job) {
    if (GetLastError() != ERROR_FILE_NOT_FOUND) return Error(env,"CHILD_UNKNOWN","Cannot inspect the operation job.");
    settled = true;
  } else {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    bool inspected = QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr);
    CloseHandle(job);
    if (!inspected) return Error(env,"CHILD_UNKNOWN","Cannot inspect operation descendants.");
    settled = accounting.ActiveProcesses == 0;
  }
#else
  if (kill(-pid,0) == 0) settled = false;
  else if (errno == ESRCH) settled = true;
  else return Error(env,"CHILD_UNKNOWN","Cannot inspect the recorded process group.");
#endif
  napi_value result; napi_get_boolean(env,settled,&result); return result;
}
}

bool InitializeChildren(napi_env env, napi_value exports) {
  auto* children = new Children();
  if (napi_add_env_cleanup_hook(env, Cleanup, children) != napi_ok) { delete children; return false; }
  napi_property_descriptor properties[] = {
    {"prepareChild", nullptr, Prepare, nullptr, nullptr, nullptr, napi_default, children},
    {"startChild", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"pollChild", nullptr, Poll, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cancelPreparedChild", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"childGroupSettled", nullptr, GroupSettled, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeChild", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr}};
  return napi_define_properties(env, exports, 6, properties) == napi_ok;
}
